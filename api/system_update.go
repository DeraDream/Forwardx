package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	updateRepository      = "DeraDream/sublinkX"
	updateCheckTimeout    = 20 * time.Second
	updateDownloadTimeout = 15 * time.Minute
)

type systemUpdateStatus struct {
	State          string    `json:"state"`
	Message        string    `json:"message"`
	Progress       int       `json:"progress"`
	CurrentVersion string    `json:"current_version"`
	TargetVersion  string    `json:"target_version"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type systemUpdater struct {
	currentVersion string
	statusPath     string
	checkClient    *http.Client
	downloadClient *http.Client
	mu             sync.Mutex
}

type githubRelease struct {
	TagName string `json:"tag_name"`
}

func NewSystemUpdater(currentVersion string) *systemUpdater {
	statusPath, err := filepath.Abs(filepath.Join("logs", "update-status.json"))
	if err != nil {
		statusPath = filepath.Join("logs", "update-status.json")
	}
	return &systemUpdater{
		currentVersion: currentVersion,
		statusPath:     statusPath,
		checkClient:    &http.Client{Timeout: updateCheckTimeout},
		downloadClient: &http.Client{Timeout: updateDownloadTimeout},
	}
}

func (u *systemUpdater) Check(c *gin.Context) {
	status := u.readStatus()
	latest, err := u.latestVersion()
	if err != nil {
		if isUpdateRunning(status) && validReleaseVersion(status.TargetVersion) {
			latest = status.TargetVersion
		} else {
			c.JSON(http.StatusBadGateway, gin.H{"msg": "检查更新失败: " + err.Error()})
			return
		}
	}
	supported, reason := updateEnvironmentSupported()
	c.JSON(http.StatusOK, gin.H{
		"code": "00000",
		"data": gin.H{
			"current_version":    u.currentVersion,
			"latest_version":     latest,
			"update_available":   compareVersions(u.currentVersion, latest) < 0,
			"supported":          supported,
			"unsupported_reason": reason,
			"status":             status,
		},
	})
}

func (u *systemUpdater) Status(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"code": "00000", "data": u.readStatus()})
}

func (u *systemUpdater) Start(c *gin.Context) {
	u.mu.Lock()
	defer u.mu.Unlock()

	if supported, reason := updateEnvironmentSupported(); !supported {
		c.JSON(http.StatusBadRequest, gin.H{"msg": reason})
		return
	}
	status := u.readStatus()
	if isUpdateRunning(status) {
		c.JSON(http.StatusConflict, gin.H{"msg": "系统正在更新，请勿重复操作"})
		return
	}
	latest, err := u.latestVersion()
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"msg": "检查更新失败: " + err.Error()})
		return
	}
	if compareVersions(u.currentVersion, latest) >= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "当前已是最新版本"})
		return
	}
	status = systemUpdateStatus{
		State:          "queued",
		Message:        "正在准备更新",
		Progress:       1,
		CurrentVersion: u.currentVersion,
		TargetVersion:  latest,
		UpdatedAt:      time.Now(),
	}
	if err := u.writeStatus(status); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "无法创建更新任务: " + err.Error()})
		return
	}
	go u.run(latest)
	c.JSON(http.StatusAccepted, gin.H{"code": "00000", "data": status, "msg": "更新任务已启动"})
}

func (u *systemUpdater) run(targetVersion string) {
	fail := func(err error) {
		_ = u.writeStatus(systemUpdateStatus{
			State:          "failed",
			Message:        err.Error(),
			Progress:       0,
			CurrentVersion: u.currentVersion,
			TargetVersion:  targetVersion,
			UpdatedAt:      time.Now(),
		})
	}

	assetName, err := updateAssetName()
	if err != nil {
		fail(err)
		return
	}
	executable, err := os.Executable()
	if err != nil {
		fail(fmt.Errorf("无法定位当前程序: %w", err))
		return
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		fail(fmt.Errorf("无法解析程序路径: %w", err))
		return
	}

	tempBinary, err := os.CreateTemp(filepath.Dir(executable), ".sublink-update-binary-*")
	if err != nil {
		fail(fmt.Errorf("无法创建更新文件: %w", err))
		return
	}
	tempBinaryPath := tempBinary.Name()
	_ = tempBinary.Close()
	tempMenu, err := os.CreateTemp(filepath.Dir(executable), ".sublink-update-menu-*")
	if err != nil {
		_ = os.Remove(tempBinaryPath)
		fail(fmt.Errorf("无法创建菜单更新文件: %w", err))
		return
	}
	tempMenuPath := tempMenu.Name()
	_ = tempMenu.Close()
	cleanup := func() {
		_ = os.Remove(tempBinaryPath)
		_ = os.Remove(tempMenuPath)
	}

	binaryURL := fmt.Sprintf("https://github.com/%s/releases/download/%s/%s", updateRepository, targetVersion, assetName)
	if err := u.download([]string{binaryURL, "https://ghfast.top/" + binaryURL}, tempBinaryPath, targetVersion, 5, 72); err != nil {
		cleanup()
		fail(fmt.Errorf("下载主程序失败: %w", err))
		return
	}
	menuURL := fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/menu.sh", updateRepository, targetVersion)
	if err := u.download([]string{menuURL, "https://ghfast.top/" + menuURL}, tempMenuPath, targetVersion, 73, 88); err != nil {
		cleanup()
		fail(fmt.Errorf("下载菜单脚本失败: %w", err))
		return
	}
	if err := os.Chmod(tempBinaryPath, 0755); err != nil {
		cleanup()
		fail(fmt.Errorf("设置主程序权限失败: %w", err))
		return
	}
	if err := os.Chmod(tempMenuPath, 0755); err != nil {
		cleanup()
		fail(fmt.Errorf("设置菜单脚本权限失败: %w", err))
		return
	}
	output, err := exec.Command(tempBinaryPath, "--version").CombinedOutput()
	if err != nil || strings.TrimSpace(string(output)) != targetVersion {
		cleanup()
		fail(errors.New("下载的主程序版本校验失败"))
		return
	}

	helper, err := u.createUpdateHelper()
	if err != nil {
		cleanup()
		fail(err)
		return
	}
	status := systemUpdateStatus{
		State:          "installing",
		Message:        "文件校验完成，正在安装并重启服务",
		Progress:       90,
		CurrentVersion: u.currentVersion,
		TargetVersion:  targetVersion,
		UpdatedAt:      time.Now(),
	}
	if err := u.writeStatus(status); err != nil {
		cleanup()
		_ = os.Remove(helper)
		fail(err)
		return
	}
	unitName := "sublink-web-update-" + strconv.FormatInt(time.Now().Unix(), 10)
	command := exec.Command(
		"systemd-run", "--unit="+unitName, "--collect", "--property=Type=oneshot",
		"/bin/bash", helper, u.statusPath, tempBinaryPath, executable,
		tempMenuPath, "/usr/bin/sublink", targetVersion, u.currentVersion,
	)
	if output, err := command.CombinedOutput(); err != nil {
		cleanup()
		_ = os.Remove(helper)
		fail(fmt.Errorf("启动后台更新任务失败: %s", strings.TrimSpace(string(output))))
	}
}

func (u *systemUpdater) latestVersion() (string, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", updateRepository)
	var lastErr error
	for _, candidate := range []string{url, "https://ghfast.top/" + url} {
		request, err := http.NewRequest(http.MethodGet, candidate, nil)
		if err != nil {
			lastErr = err
			continue
		}
		request.Header.Set("User-Agent", "SublinkX-Updater")
		response, err := u.checkClient.Do(request)
		if err != nil {
			lastErr = err
			continue
		}
		var release githubRelease
		err = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&release)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK || err != nil {
			lastErr = fmt.Errorf("GitHub 返回状态 %d", response.StatusCode)
			continue
		}
		if !validReleaseVersion(release.TagName) {
			lastErr = errors.New("GitHub 返回了无效版本号")
			continue
		}
		return release.TagName, nil
	}
	return "", lastErr
}

func (u *systemUpdater) download(urls []string, destination, targetVersion string, progressStart, progressEnd int) error {
	var lastErr error
	for _, candidate := range urls {
		file, err := os.OpenFile(destination, os.O_WRONLY|os.O_TRUNC, 0600)
		if err != nil {
			return err
		}
		request, err := http.NewRequest(http.MethodGet, candidate, nil)
		if err != nil {
			_ = file.Close()
			lastErr = err
			continue
		}
		request.Header.Set("User-Agent", "SublinkX-Updater")
		response, err := u.downloadClient.Do(request)
		if err != nil {
			_ = file.Close()
			lastErr = err
			continue
		}
		if response.StatusCode != http.StatusOK {
			_ = response.Body.Close()
			_ = file.Close()
			lastErr = fmt.Errorf("下载返回状态 %d", response.StatusCode)
			continue
		}
		reader := &updateProgressReader{
			reader: response.Body,
			total:  response.ContentLength,
			onProgress: func(value int) {
				progress := progressStart
				if value >= 0 {
					progress += (progressEnd - progressStart) * value / 100
				}
				_ = u.writeStatus(systemUpdateStatus{
					State: "downloading", Message: "正在下载更新文件", Progress: progress,
					CurrentVersion: u.currentVersion, TargetVersion: targetVersion, UpdatedAt: time.Now(),
				})
			},
		}
		_, copyErr := io.Copy(file, reader)
		closeErr := file.Close()
		_ = response.Body.Close()
		if copyErr == nil && closeErr == nil {
			return nil
		}
		if copyErr != nil {
			lastErr = copyErr
		} else {
			lastErr = closeErr
		}
	}
	return lastErr
}

type updateProgressReader struct {
	reader     io.Reader
	total      int64
	read       int64
	last       int
	onProgress func(int)
}

func (r *updateProgressReader) Read(buffer []byte) (int, error) {
	n, err := r.reader.Read(buffer)
	r.read += int64(n)
	if r.total > 0 {
		progress := int(r.read * 100 / r.total)
		if progress >= r.last+5 || progress == 100 {
			r.last = progress
			r.onProgress(progress)
		}
	}
	return n, err
}

func (u *systemUpdater) readStatus() systemUpdateStatus {
	data, err := os.ReadFile(u.statusPath)
	if err != nil {
		return systemUpdateStatus{State: "idle", CurrentVersion: u.currentVersion}
	}
	var status systemUpdateStatus
	if json.Unmarshal(data, &status) != nil {
		return systemUpdateStatus{State: "idle", CurrentVersion: u.currentVersion}
	}
	return status
}

func (u *systemUpdater) writeStatus(status systemUpdateStatus) error {
	if err := os.MkdirAll(filepath.Dir(u.statusPath), 0755); err != nil {
		return err
	}
	data, err := json.Marshal(status)
	if err != nil {
		return err
	}
	tempPath := u.statusPath + ".tmp"
	if err := os.WriteFile(tempPath, data, 0644); err != nil {
		return err
	}
	return os.Rename(tempPath, u.statusPath)
}

func (u *systemUpdater) createUpdateHelper() (string, error) {
	helper, err := os.CreateTemp(filepath.Dir(u.statusPath), "sublink-update-helper-*.sh")
	if err != nil {
		return "", err
	}
	script := `#!/bin/bash
set -Eeuo pipefail
STATUS="$1"; NEW_BIN="$2"; TARGET_BIN="$3"; NEW_MENU="$4"; TARGET_MENU="$5"; TARGET_VERSION="$6"; CURRENT_VERSION="$7"
BACKUP_BIN="${NEW_BIN}.backup"; BACKUP_MENU="${NEW_MENU}.backup"
write_status() {
  local state="$1" message="$2" progress="$3" now tmp
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ); tmp="${STATUS}.tmp"
  printf '{"state":"%s","message":"%s","progress":%s,"current_version":"%s","target_version":"%s","updated_at":"%s"}\n' "$state" "$message" "$progress" "$CURRENT_VERSION" "$TARGET_VERSION" "$now" > "$tmp"
  mv -f "$tmp" "$STATUS"
}
rollback() {
  trap - ERR
  [ -f "$BACKUP_BIN" ] && install -m 755 "$BACKUP_BIN" "$TARGET_BIN" || true
  [ -f "$BACKUP_MENU" ] && install -m 755 "$BACKUP_MENU" "$TARGET_MENU" || true
  systemctl start sublink 2>/dev/null || true
  write_status failed "更新失败，已恢复原版本" 0 || true
  rm -f "$NEW_BIN" "$NEW_MENU" "$BACKUP_BIN" "$BACKUP_MENU" "$0"
}
trap rollback ERR
cp -p "$TARGET_BIN" "$BACKUP_BIN"
[ -f "$TARGET_MENU" ] && cp -p "$TARGET_MENU" "$BACKUP_MENU" || true
write_status installing "正在停止服务并替换程序" 94
systemctl stop sublink
install -m 755 "$NEW_BIN" "$TARGET_BIN"
install -m 755 "$NEW_MENU" "$TARGET_MENU"
write_status restarting "程序已更新，正在重启服务" 98
systemctl daemon-reload
systemctl start sublink
systemctl is-active --quiet sublink
write_status completed "更新完成，正在刷新页面" 100
trap - ERR
rm -f "$NEW_BIN" "$NEW_MENU" "$BACKUP_BIN" "$BACKUP_MENU" "$0"
`
	if _, err := helper.WriteString(script); err != nil {
		_ = helper.Close()
		_ = os.Remove(helper.Name())
		return "", err
	}
	if err := helper.Close(); err != nil {
		_ = os.Remove(helper.Name())
		return "", err
	}
	if err := os.Chmod(helper.Name(), 0700); err != nil {
		_ = os.Remove(helper.Name())
		return "", err
	}
	return helper.Name(), nil
}

func updateEnvironmentSupported() (bool, string) {
	if runtime.GOOS != "linux" {
		return false, "Web 在线升级目前仅支持使用 systemd 的 Linux 安装环境"
	}
	if os.Geteuid() != 0 {
		return false, "在线升级需要 SublinkX 服务以 root 权限运行"
	}
	if _, err := exec.LookPath("systemd-run"); err != nil {
		return false, "当前系统缺少 systemd-run，无法安全执行在线升级"
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return false, "当前系统缺少 systemctl，无法安全执行在线升级"
	}
	executable, err := os.Executable()
	if err != nil {
		return false, "无法识别当前程序安装路径"
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil || filepath.Clean(executable) != "/usr/local/bin/sublink/sublink" {
		return false, "Web 在线升级仅支持 SublinkX 标准安装路径"
	}
	if err := exec.Command("systemctl", "is-active", "--quiet", "sublink").Run(); err != nil {
		return false, "SublinkX systemd 服务当前未运行"
	}
	return true, ""
}

func updateAssetName() (string, error) {
	switch runtime.GOARCH {
	case "amd64":
		return "sublink_amd64", nil
	case "arm64":
		return "sublink_arm64", nil
	default:
		return "", fmt.Errorf("不支持的处理器架构: %s", runtime.GOARCH)
	}
}

func validReleaseVersion(version string) bool {
	if version == "" || len(version) > 32 {
		return false
	}
	for _, char := range version {
		if (char < '0' || char > '9') && char != '.' {
			return false
		}
	}
	return true
}

func compareVersions(left, right string) int {
	leftParts := strings.Split(strings.TrimPrefix(left, "v"), ".")
	rightParts := strings.Split(strings.TrimPrefix(right, "v"), ".")
	length := len(leftParts)
	if len(rightParts) > length {
		length = len(rightParts)
	}
	for index := 0; index < length; index++ {
		leftValue, rightValue := 0, 0
		if index < len(leftParts) {
			leftValue, _ = strconv.Atoi(leftParts[index])
		}
		if index < len(rightParts) {
			rightValue, _ = strconv.Atoi(rightParts[index])
		}
		if leftValue < rightValue {
			return -1
		}
		if leftValue > rightValue {
			return 1
		}
	}
	return 0
}

func isUpdateRunning(status systemUpdateStatus) bool {
	switch status.State {
	case "queued", "downloading", "installing", "restarting":
		return time.Since(status.UpdatedAt) < 15*time.Minute
	default:
		return false
	}
}
