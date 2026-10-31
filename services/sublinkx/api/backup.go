package api

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"sublink/models"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gopkg.in/yaml.v3"
	"gorm.io/gorm"
)

const (
	backupMagic       = "SLXBACK1"
	backupSaltSize    = 16
	backupNonceSize   = 12
	backupMaxSize     = 256 << 20
	backupMaxFileSize = 200 << 20
	backupIterations  = 600000
)

var (
	backupRestartDelay = time.Second
	restartProcess     = func() { os.Exit(1) }
)

type backupManifest struct {
	Version   int      `json:"version"`
	CreatedAt string   `json:"created_at"`
	Files     []string `json:"files"`
}

func BackupExport(c *gin.Context) {
	password := c.PostForm("password")
	if err := validateBackupPassword(password); password != "" && err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	if models.DB == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "数据库未初始化"})
		return
	}
	// VACUUM INTO produces a consistent SQLite snapshot even while the live
	// database receives writes; copying the main file after a checkpoint does not.
	snapshotDir, err := os.MkdirTemp("", "sublink-export-")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "无法准备订阅数据库备份"})
		return
	}
	defer os.RemoveAll(snapshotDir)
	snapshotPath := filepath.Join(snapshotDir, "sublink.db")
	if err := models.DB.Exec("VACUUM INTO ?", snapshotPath).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "无法生成一致的数据库备份"})
		return
	}

	archive, err := buildBackupArchiveFromDatabase(snapshotPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "生成备份失败"})
		return
	}
	output := archive
	if password != "" {
		output, err = encryptBackup(archive, password)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"msg": "加密备份失败"})
			return
		}
	}
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Disposition", `attachment; filename="sublink-backup.sublink-backup"`)
	c.Data(http.StatusOK, "application/octet-stream", output)
}

func BackupImport(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, backupMaxSize+(1<<20))
	password := c.PostForm("password")
	file, err := c.FormFile("file")
	if err != nil || file.Size > backupMaxSize {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "备份文件无效或超过 256 MB"})
		return
	}
	source, err := file.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "无法读取备份文件"})
		return
	}
	defer source.Close()
	data, err := io.ReadAll(io.LimitReader(source, backupMaxSize+1))
	if err != nil || int64(len(data)) > backupMaxSize {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "备份文件读取失败"})
		return
	}
	archive := data
	if isEncryptedBackup(data) {
		if err := validateBackupPassword(password); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"msg": "此备份已加密，请输入至少 8 位备份密码"})
			return
		}
		archive, err = decryptBackup(data, password)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"msg": "备份密码错误或文件已损坏"})
			return
		}
	}
	tempDir, err := os.MkdirTemp("", "sublink-restore-")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "无法准备恢复目录"})
		return
	}
	defer os.RemoveAll(tempDir)
	if err := unpackBackup(archive, tempDir); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	if err := validateBackupDatabase(filepath.Join(tempDir, "db/sublink.db")); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "备份数据库校验失败"})
		return
	}
	config, err := backupConfig(tempDir)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "备份端口配置无效"})
		return
	}
	if err := restoreBackup(tempDir); err != nil {
		// restoreBackup closes the live database before changing files, even if
		// a subsequent operation fails. Restart to reopen the rolled-back DB.
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "恢复失败，请检查文件权限；订阅服务正在重启"})
		scheduleProcessRestart()
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": "00000", "data": gin.H{"port": config.Port, "restart_delay_ms": 4500}, "msg": "恢复成功，服务正在重启"})
	scheduleProcessRestart()
}

func backupConfig(dir string) (models.Config, error) {
	data, err := os.ReadFile(filepath.Join(dir, "db/config.yaml"))
	if err != nil {
		return models.Config{}, err
	}
	var config models.Config
	if err := yaml.Unmarshal(data, &config); err != nil || config.Port < 1 || config.Port > 65535 {
		return models.Config{}, errors.New("invalid config")
	}
	return config, nil
}

func scheduleProcessRestart() {
	restart := restartProcess
	time.AfterFunc(backupRestartDelay, restart)
}

func validateBackupPassword(password string) error {
	if len([]byte(password)) < 8 {
		return errors.New("备份密码至少 8 位")
	}
	return nil
}

func buildBackupArchive() ([]byte, error) {
	return buildBackupArchiveFromDatabase("./db/sublink.db")
}

func buildBackupArchiveFromDatabase(databasePath string) ([]byte, error) {
	var raw bytes.Buffer
	zw := gzip.NewWriter(&raw)
	tw := tar.NewWriter(zw)
	manifest := backupManifest{Version: 1, CreatedAt: time.Now().UTC().Format(time.RFC3339), Files: []string{"db/sublink.db", "db/config.yaml"}}
	if err := addTarFile(tw, "db/sublink.db", databasePath); err != nil {
		return nil, err
	}
	if err := addTarFile(tw, "db/config.yaml", "./db/config.yaml"); err != nil {
		return nil, err
	}
	addTemplateDir := func(directory string) error {
		return filepath.WalkDir(directory, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return nil
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("模板目录不能包含符号链接")
			}
			rel, err := filepath.Rel(".", path)
			if err != nil {
				return err
			}
			manifest.Files = append(manifest.Files, filepath.ToSlash(rel))
			return addTarFile(tw, filepath.ToSlash(rel), path)
		})
	}
	err := addTemplateDir("./template")
	if err == nil {
		if _, statErr := os.Stat("./rule_templates"); statErr == nil {
			err = addTemplateDir("./rule_templates")
		} else if !os.IsNotExist(statErr) {
			err = statErr
		}
	}
	if err != nil {
		return nil, err
	}
	manifestData, _ := json.Marshal(manifest)
	if err := addTarBytes(tw, "manifest.json", manifestData); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return raw.Bytes(), nil
}

func addTarFile(tw *tar.Writer, name, path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() > backupMaxFileSize {
		return fmt.Errorf("备份文件过大")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return addTarBytes(tw, name, data)
}

func addTarBytes(tw *tar.Writer, name string, data []byte) error {
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: int64(len(data))}); err != nil {
		return err
	}
	_, err := tw.Write(data)
	return err
}

func encryptBackup(plain []byte, password string) ([]byte, error) {
	salt := make([]byte, backupSaltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(deriveBackupKey(password, salt))
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, backupNonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	ciphertext := gcm.Seal(nil, nonce, plain, []byte(backupMagic))
	result := make([]byte, 0, len(backupMagic)+backupSaltSize+backupNonceSize+len(ciphertext))
	result = append(result, backupMagic...)
	result = append(result, salt...)
	result = append(result, nonce...)
	result = append(result, ciphertext...)
	return result, nil
}

func decryptBackup(data []byte, password string) ([]byte, error) {
	minimum := len(backupMagic) + backupSaltSize + backupNonceSize
	if len(data) < minimum || string(data[:len(backupMagic)]) != backupMagic {
		return nil, errors.New("invalid backup")
	}
	offset := len(backupMagic)
	salt := data[offset : offset+backupSaltSize]
	offset += backupSaltSize
	nonce := data[offset : offset+backupNonceSize]
	offset += backupNonceSize
	block, err := aes.NewCipher(deriveBackupKey(password, salt))
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, data[offset:], []byte(backupMagic))
}

func isEncryptedBackup(data []byte) bool {
	return len(data) >= len(backupMagic) && string(data[:len(backupMagic)]) == backupMagic
}

func deriveBackupKey(password string, salt []byte) []byte {
	// ponytail: fixed PBKDF2 cost keeps the format dependency-free; raise it with a version bump if hardware changes materially.
	key := make([]byte, 32)
	var counter [4]byte
	for block := uint32(1); block <= 1; block++ {
		binary.BigEndian.PutUint32(counter[:], block)
		h := hmac.New(sha256.New, []byte(password))
		h.Write(salt)
		h.Write(counter[:])
		u := h.Sum(nil)
		copy(key, u)
		for i := 1; i < backupIterations; i++ {
			h = hmac.New(sha256.New, []byte(password))
			h.Write(u)
			u = h.Sum(nil)
			for j := range key {
				key[j] ^= u[j]
			}
		}
	}
	return key
}

func unpackBackup(archive []byte, dir string) error {
	zr, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return errors.New("备份压缩数据无效")
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	seen := map[string]bool{}
	var totalSize int64
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return errors.New("备份归档无效")
		}
		name := filepath.ToSlash(filepath.Clean(header.Name))
		if header.Typeflag != tar.TypeReg || name == "." || strings.HasPrefix(name, "../") || strings.Contains(name, "/../") || filepath.IsAbs(name) || seen[name] {
			return errors.New("备份包含不支持的文件")
		}
		if header.Size < 0 || header.Size > backupMaxFileSize {
			return errors.New("备份文件过大")
		}
		totalSize += header.Size
		if totalSize > backupMaxSize {
			return errors.New("备份解压后过大")
		}
		allowed := name == "manifest.json" || name == "db/sublink.db" || name == "db/config.yaml" || strings.HasPrefix(name, "template/") || strings.HasPrefix(name, "rule_templates/")
		if !allowed {
			return errors.New("备份包含未知文件")
		}
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		out, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
		if err != nil {
			return err
		}
		_, copyErr := io.CopyN(out, tr, header.Size)
		closeErr := out.Close()
		if copyErr != nil || closeErr != nil {
			return errors.New("备份文件写入失败")
		}
		seen[name] = true
	}
	if !seen["manifest.json"] || !seen["db/sublink.db"] || !seen["db/config.yaml"] {
		return errors.New("备份缺少必要文件")
	}
	var manifest backupManifest
	data, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil || json.Unmarshal(data, &manifest) != nil || manifest.Version != 1 {
		return errors.New("不支持的备份版本")
	}
	if _, err := backupConfig(dir); err != nil {
		return errors.New("备份配置无效")
	}
	if err := os.MkdirAll(filepath.Join(dir, "template"), 0700); err != nil {
		return err
	}
	return os.MkdirAll(filepath.Join(dir, "rule_templates"), 0700)
}

func validateBackupDatabase(path string) error {
	if info, err := os.Stat(path); err != nil || info.Size() == 0 {
		return errors.New("invalid db")
	}
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{})
	if err != nil {
		return err
	}
	var integrity string
	if err := db.Raw("PRAGMA integrity_check").Scan(&integrity).Error; err != nil || integrity != "ok" {
		return errors.New("invalid db")
	}
	var users int64
	if err := db.Model(&models.User{}).Count(&users).Error; err != nil || users == 0 {
		return errors.New("invalid users")
	}
	sqlDB, _ := db.DB()
	return sqlDB.Close()
}

func restoreBackup(dir string) error {
	if models.DB != nil {
		if sqlDB, err := models.DB.DB(); err == nil {
			_ = sqlDB.Close()
		}
	}
	if err := os.Remove("./db/sublink.db-wal"); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Remove("./db/sublink.db-shm"); err != nil && !os.IsNotExist(err) {
		return err
	}
	rollback, err := os.MkdirTemp("", "sublink-rollback-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(rollback)
	if err := copyExistingFile("./db/sublink.db", filepath.Join(rollback, "sublink.db")); err != nil {
		return err
	}
	if err := copyExistingFile("./db/config.yaml", filepath.Join(rollback, "config.yaml")); err != nil {
		return err
	}
	if err := copyExistingDir("./template", filepath.Join(rollback, "template")); err != nil {
		return err
	}
	if err := copyExistingDir("./rule_templates", filepath.Join(rollback, "rule_templates")); err != nil {
		return err
	}
	restoreOld := func() {
		_ = copyFileAtomic(filepath.Join(rollback, "sublink.db"), "./db/sublink.db", 0600)
		_ = copyFileAtomic(filepath.Join(rollback, "config.yaml"), "./db/config.yaml", 0600)
		_ = os.RemoveAll("./template")
		_ = copyDir(filepath.Join(rollback, "template"), "./template")
		_ = os.RemoveAll("./rule_templates")
		_ = copyDir(filepath.Join(rollback, "rule_templates"), "./rule_templates")
	}
	if err := copyFileAtomic(filepath.Join(dir, "db/sublink.db"), "./db/sublink.db", 0600); err != nil {
		restoreOld()
		return err
	}
	if err := copyFileAtomic(filepath.Join(dir, "db/config.yaml"), "./db/config.yaml", 0600); err != nil {
		restoreOld()
		return err
	}
	if err := os.RemoveAll("./template"); err != nil {
		restoreOld()
		return err
	}
	if err := copyDir(filepath.Join(dir, "template"), "./template"); err != nil {
		restoreOld()
		return err
	}
	if err := os.RemoveAll("./rule_templates"); err != nil {
		restoreOld()
		return err
	}
	if err := copyDir(filepath.Join(dir, "rule_templates"), "./rule_templates"); err != nil {
		restoreOld()
		return err
	}
	return nil
}

func copyExistingFile(source, target string) error {
	if _, err := os.Stat(source); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	return copyFileAtomic(source, target, 0600)
}

func copyFileAtomic(source, target string, mode os.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return err
	}
	output, err := os.CreateTemp(filepath.Dir(target), ".sublink-restore-")
	if err != nil {
		return err
	}
	temporary := output.Name()
	defer os.Remove(temporary)
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		return err
	}
	if err := output.Chmod(mode); err != nil {
		output.Close()
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	return os.Rename(temporary, target)
}

func copyExistingDir(source, target string) error {
	if _, err := os.Stat(source); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	return copyDir(source, target)
}

func copyDir(source, target string) error {
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, rel)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0700)
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
			return errors.New("模板目录包含不支持的文件")
		}
		return copyFileAtomic(path, destination, 0644)
	})
}
