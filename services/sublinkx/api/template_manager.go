package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"sublink/utils"

	"github.com/gin-gonic/gin"
)

// VisualTemplate is deliberately separate from Temp.  Visual templates live
// under rule_templates and are never considered by the existing subscription
// template list.
type VisualTemplate struct {
	File      string `json:"file"`
	UpdatedAt string `json:"updated_at"`
	Type      string `json:"type"`
}

type visualTemplatePayload struct {
	Filename string `json:"filename"`
	OldName  string `json:"old_name"`
	Content  string `json:"content"`
	Type     string `json:"type"`
}

type visualTemplateFetchPayload struct {
	URL string `json:"url"`
}

var visualTemplateDir string
var visualTemplateDirOnce sync.Once
var visualTemplateDirErr error

func ensureVisualTemplateDir() error {
	visualTemplateDirOnce.Do(func() {
		cwd, err := os.Getwd()
		if err != nil {
			visualTemplateDirErr = fmt.Errorf("无法获取当前工作目录: %w", err)
			return
		}
		visualTemplateDir, err = filepath.Abs(filepath.Join(cwd, "rule_templates"))
		if err != nil {
			visualTemplateDirErr = fmt.Errorf("无法解析可视化模板目录: %w", err)
			return
		}
		visualTemplateDirErr = os.MkdirAll(visualTemplateDir, 0755)
	})
	return visualTemplateDirErr
}

func visualTemplatePath(filename string) (string, error) {
	if err := ensureVisualTemplateDir(); err != nil {
		return "", err
	}
	filename = strings.TrimSpace(filename)
	if filepath.Ext(filename) == "" {
		filename += ".yaml"
	}
	if !isVisualTemplateFilename(filename) {
		return "", errors.New("可视化模板仅支持 .yaml、.yml 或 .conf 文件")
	}
	clean := filepath.Clean(filename)
	if clean == "." || clean == ".." || strings.ContainsAny(clean, "/\\") {
		return "", errors.New("文件名无效")
	}
	path := filepath.Join(visualTemplateDir, clean)
	rel, err := filepath.Rel(visualTemplateDir, path)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return "", errors.New("文件名无效")
	}
	return path, nil
}

func isVisualTemplateFilename(filename string) bool {
	return isYAMLTemplateFilename(filename) || strings.EqualFold(filepath.Ext(filename), ".conf")
}

// detectVisualTemplateType intentionally uses content before the filename:
// both Clash/Mihomo and Egern use YAML, so an extension alone is ambiguous.
func detectVisualTemplateType(filename, content string) string {
	if strings.EqualFold(filepath.Ext(filename), ".conf") || strings.Contains(content, "[Proxy Group]") {
		return "loon"
	}
	if strings.Contains(content, "policy_groups:") || strings.Contains(content, "modules:") {
		return "egern"
	}
	return "clash"
}

func validateVisualTemplate(filename, content, requestedType string) (string, error) {
	kind := detectVisualTemplateType(filename, content)
	if requestedType != "" && requestedType != kind {
		return "", fmt.Errorf("模板类型与内容不一致：当前内容识别为 %s", kind)
	}
	if kind == "loon" {
		if !strings.Contains(content, "[") || !strings.Contains(content, "]") {
			return "", errors.New("Loon 配置至少需要一个 INI 分段，例如 [Proxy Group]")
		}
		return kind, nil
	}
	if err := validateYAMLTemplate(filename, content); err != nil {
		return "", err
	}
	return kind, nil
}

func visualTemplateJSON(c *gin.Context) (visualTemplatePayload, bool) {
	var payload visualTemplatePayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(400, gin.H{"msg": "请求数据无效"})
		return payload, false
	}
	payload.Filename = strings.TrimSpace(payload.Filename)
	payload.OldName = strings.TrimSpace(payload.OldName)
	payload.Type = strings.TrimSpace(payload.Type)
	return payload, true
}

func ListVisualTemplates(c *gin.Context) {
	if err := ensureVisualTemplateDir(); err != nil {
		c.JSON(500, gin.H{"msg": err.Error()})
		return
	}
	entries, err := os.ReadDir(visualTemplateDir)
	if err != nil {
		c.JSON(500, gin.H{"msg": "无法读取可视化模板目录"})
		return
	}
	items := make([]VisualTemplate, 0)
	for _, entry := range entries {
		if entry.IsDir() || !isVisualTemplateFilename(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		content, err := os.ReadFile(filepath.Join(visualTemplateDir, entry.Name()))
		if err != nil {
			continue
		}
		items = append(items, VisualTemplate{File: entry.Name(), UpdatedAt: utils.FormatBeijingTime(info.ModTime()), Type: detectVisualTemplateType(entry.Name(), string(content))})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].File < items[j].File })
	c.JSON(200, gin.H{"code": "00000", "data": items, "msg": "ok"})
}

func GetVisualTemplate(c *gin.Context) {
	path, err := visualTemplatePath(c.Query("filename"))
	if err != nil {
		c.JSON(400, gin.H{"msg": err.Error()})
		return
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		c.JSON(404, gin.H{"msg": "模板不存在"})
		return
	}
	content, err := os.ReadFile(path)
	if err != nil {
		c.JSON(500, gin.H{"msg": "无法读取模板"})
		return
	}
	c.JSON(200, gin.H{"code": "00000", "data": gin.H{"file": filepath.Base(path), "content": string(content), "type": detectVisualTemplateType(filepath.Base(path), string(content))}, "msg": "ok"})
}

func CreateVisualTemplate(c *gin.Context) {
	payload, ok := visualTemplateJSON(c)
	if !ok {
		return
	}
	path, err := visualTemplatePath(payload.Filename)
	if err != nil {
		c.JSON(400, gin.H{"msg": err.Error()})
		return
	}
	if strings.TrimSpace(payload.Content) == "" {
		c.JSON(400, gin.H{"msg": "模板内容不能为空"})
		return
	}
	if _, err := validateVisualTemplate(path, payload.Content, payload.Type); err != nil {
		c.JSON(400, gin.H{"msg": err.Error()})
		return
	}
	if _, err := os.Lstat(path); err == nil {
		c.JSON(409, gin.H{"msg": "模板已存在"})
		return
	} else if !errors.Is(err, os.ErrNotExist) {
		c.JSON(500, gin.H{"msg": "无法创建模板"})
		return
	}
	if err := os.WriteFile(path, []byte(payload.Content), 0644); err != nil {
		c.JSON(500, gin.H{"msg": "保存模板失败"})
		return
	}
	c.JSON(200, gin.H{"code": "00000", "msg": "创建成功"})
}

func UpdateVisualTemplate(c *gin.Context) {
	payload, ok := visualTemplateJSON(c)
	if !ok {
		return
	}
	if payload.OldName == "" {
		c.JSON(400, gin.H{"msg": "原模板名不能为空"})
		return
	}
	oldPath, err := visualTemplatePath(payload.OldName)
	if err != nil {
		c.JSON(400, gin.H{"msg": err.Error()})
		return
	}
	newPath, err := visualTemplatePath(payload.Filename)
	if err != nil {
		c.JSON(400, gin.H{"msg": err.Error()})
		return
	}
	if strings.TrimSpace(payload.Content) == "" {
		c.JSON(400, gin.H{"msg": "模板内容不能为空"})
		return
	}
	if _, err := validateVisualTemplate(newPath, payload.Content, payload.Type); err != nil {
		c.JSON(400, gin.H{"msg": err.Error()})
		return
	}
	info, err := os.Lstat(oldPath)
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		c.JSON(404, gin.H{"msg": "原模板不存在"})
		return
	}
	if oldPath != newPath {
		if _, err := os.Lstat(newPath); err == nil {
			c.JSON(409, gin.H{"msg": "新模板名已存在"})
			return
		} else if !errors.Is(err, os.ErrNotExist) {
			c.JSON(500, gin.H{"msg": "无法更新模板"})
			return
		}
		if err := os.Rename(oldPath, newPath); err != nil {
			c.JSON(500, gin.H{"msg": "重命名模板失败"})
			return
		}
	}
	if err := os.WriteFile(newPath, []byte(payload.Content), 0644); err != nil {
		c.JSON(500, gin.H{"msg": "保存模板失败"})
		return
	}
	c.JSON(200, gin.H{"code": "00000", "msg": "保存成功"})
}

func DeleteVisualTemplate(c *gin.Context) {
	payload, ok := visualTemplateJSON(c)
	if !ok {
		return
	}
	path, err := visualTemplatePath(payload.Filename)
	if err != nil {
		c.JSON(400, gin.H{"msg": err.Error()})
		return
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		c.JSON(404, gin.H{"msg": "模板不存在"})
		return
	}
	if err := os.Remove(path); err != nil {
		c.JSON(500, gin.H{"msg": "删除模板失败"})
		return
	}
	c.JSON(200, gin.H{"code": "00000", "msg": "删除成功"})
}

func FetchVisualTemplateSource(c *gin.Context) {
	var payload visualTemplateFetchPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(400, gin.H{"msg": "订阅地址无效"})
		return
	}
	parsed, err := url.Parse(strings.TrimSpace(payload.URL))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		c.JSON(400, gin.H{"msg": "请输入有效的 HTTP(S) 订阅地址"})
		return
	}
	dialer := &net.Dialer{Timeout: 8 * time.Second}
	transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		for _, item := range ips {
			if item.IP.IsLoopback() || item.IP.IsPrivate() || item.IP.IsLinkLocalUnicast() || item.IP.IsUnspecified() {
				return nil, errors.New("订阅地址不能指向本地或私有网络")
			}
		}
		return dialer.DialContext(ctx, network, address)
	}}
	client := &http.Client{Timeout: 15 * time.Second, Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return errors.New("重定向次数过多")
		}
		return nil
	}}
	resp, err := client.Get(parsed.String())
	if err != nil {
		c.JSON(400, gin.H{"msg": "拉取订阅失败：" + err.Error()})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		c.JSON(400, gin.H{"msg": fmt.Sprintf("订阅服务器返回 %d", resp.StatusCode)})
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		c.JSON(500, gin.H{"msg": "读取订阅失败"})
		return
	}
	if len(body) >= 2<<20 {
		c.JSON(400, gin.H{"msg": "订阅内容超过 2MB 限制"})
		return
	}
	c.JSON(200, gin.H{"code": "00000", "data": gin.H{"content": string(body)}, "msg": "ok"})
}
