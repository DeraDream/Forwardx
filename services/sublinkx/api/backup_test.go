package api

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"sublink/models"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func TestBackupEncryptionRoundTrip(t *testing.T) {
	plain := []byte("sublink backup")
	ciphertext, err := encryptBackup(plain, "correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decryptBackup(ciphertext, "correct horse battery")
	if err != nil || string(decoded) != string(plain) {
		t.Fatalf("backup encryption round trip failed: %v", err)
	}
	if _, err := decryptBackup(ciphertext, "wrong password"); err == nil {
		t.Fatal("wrong password was accepted")
	}
}

func TestEncryptedBackupRequiresPassword(t *testing.T) {
	ciphertext, err := encryptBackup([]byte("not an archive"), "correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !isEncryptedBackup(ciphertext) {
		t.Fatal("encrypted backup was not recognized")
	}
	if err := validateBackupPassword(""); err == nil {
		t.Fatal("empty password was accepted")
	}
}

func TestBackupArchiveRoundTrip(t *testing.T) {
	root := t.TempDir()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })
	if err := os.MkdirAll("db", 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll("template/nested", 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll("rule_templates", 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("db/config.yaml", []byte("jwt_secret: test\nexpire_days: 14\nport: 8000\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("template/nested/test.yaml", []byte("mode: rule\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("rule_templates/managed.yaml", []byte("proxy-groups: []\n"), 0644); err != nil {
		t.Fatal(err)
	}
	db, err := gorm.Open(sqlite.Open("db/sublink.db"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&models.User{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&models.User{Username: "admin", Password: "secret"}).Error; err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}

	archive, err := buildBackupArchive()
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, err := encryptBackup(archive, "correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := decryptBackup(ciphertext, "correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	restored := filepath.Join(root, "restored")
	if err := unpackBackup(plain, restored); err != nil {
		t.Fatal(err)
	}
	if err := validateBackupDatabase(filepath.Join(restored, "db/sublink.db")); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(restored, "template/nested/test.yaml"))
	if err != nil || string(data) != "mode: rule\n" {
		t.Fatalf("template was not restored: %v", err)
	}
	managed, err := os.ReadFile(filepath.Join(restored, "rule_templates/managed.yaml"))
	if err != nil || string(managed) != "proxy-groups: []\n" {
		t.Fatalf("managed template was not restored: %v", err)
	}
}

func TestBackupHandlersRestoreAllData(t *testing.T) {
	gin.SetMode(gin.TestMode)
	root := t.TempDir()
	previousDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	previousDB := models.DB
	previousRestart := restartProcess
	previousDelay := backupRestartDelay
	restarted := make(chan struct{}, 1)
	restartProcess = func() { restarted <- struct{}{} }
	backupRestartDelay = 0
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		models.DB = previousDB
		restartProcess = previousRestart
		backupRestartDelay = previousDelay
		_ = os.Chdir(previousDir)
	})
	if err := os.MkdirAll("db", 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll("template", 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("db/config.yaml", []byte("jwt_secret: original\nexpire_days: 14\nport: 8000\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("template/original.yaml", []byte("original\n"), 0644); err != nil {
		t.Fatal(err)
	}
	db, err := gorm.Open(sqlite.Open("db/sublink.db"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&models.User{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&models.User{Username: "admin", Password: "original"}).Error; err != nil {
		t.Fatal(err)
	}
	models.DB = db

	exportBody := &bytes.Buffer{}
	exportForm := multipart.NewWriter(exportBody)
	if err := exportForm.Close(); err != nil {
		t.Fatal(err)
	}
	exportRecorder := httptest.NewRecorder()
	exportContext, _ := gin.CreateTestContext(exportRecorder)
	exportContext.Request = httptest.NewRequest(http.MethodPost, "/api/v1/backup/export", exportBody)
	exportContext.Request.Header.Set("Content-Type", exportForm.FormDataContentType())
	BackupExport(exportContext)
	if exportRecorder.Code != http.StatusOK {
		t.Fatalf("export failed: %s", exportRecorder.Body.String())
	}
	if isEncryptedBackup(exportRecorder.Body.Bytes()) {
		t.Fatal("empty export password should produce an unencrypted backup")
	}

	if err := db.Create(&models.User{Username: "changed", Password: "changed"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("db/config.yaml", []byte("jwt_secret: changed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("template/changed.yaml", []byte("changed\n"), 0644); err != nil {
		t.Fatal(err)
	}

	importBody := &bytes.Buffer{}
	importForm := multipart.NewWriter(importBody)
	file, err := importForm.CreateFormFile("file", "backup.sublink-backup")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(exportRecorder.Body.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := importForm.Close(); err != nil {
		t.Fatal(err)
	}
	importRecorder := httptest.NewRecorder()
	importContext, _ := gin.CreateTestContext(importRecorder)
	importContext.Request = httptest.NewRequest(http.MethodPost, "/api/v1/backup/import", importBody)
	importContext.Request.Header.Set("Content-Type", importForm.FormDataContentType())
	BackupImport(importContext)
	if importRecorder.Code != http.StatusOK {
		t.Fatalf("import failed: %s", importRecorder.Body.String())
	}
	if !bytes.Contains(importRecorder.Body.Bytes(), []byte(`"port":8000`)) {
		t.Fatalf("restore response did not include backup port: %s", importRecorder.Body.String())
	}
	select {
	case <-restarted:
	case <-time.After(time.Second):
		t.Fatal("restore did not schedule a restart")
	}

	restored, err := gorm.Open(sqlite.Open("db/sublink.db"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	var users []models.User
	if err := restored.Find(&users).Error; err != nil || len(users) != 1 || users[0].Username != "admin" {
		t.Fatalf("database was not restored: users=%#v err=%v", users, err)
	}
	restoredSQL, _ := restored.DB()
	_ = restoredSQL.Close()
	if data, err := os.ReadFile("db/config.yaml"); err != nil || string(data) != "jwt_secret: original\nexpire_days: 14\nport: 8000\n" {
		t.Fatalf("config was not restored: %q, %v", data, err)
	}
	if _, err := os.Stat("template/original.yaml"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat("template/changed.yaml"); !os.IsNotExist(err) {
		t.Fatalf("old template was not removed: %v", err)
	}
}
