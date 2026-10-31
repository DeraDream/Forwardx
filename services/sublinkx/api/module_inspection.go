package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gopkg.in/yaml.v3"
)

// ModuleInspection is a normalized, read-only description of an Egern module
// or Loon plugin. Keeping this parser server-side avoids browser CORS workarounds
// and ensures every remote fetch receives the same SSRF protection.
type ModuleInspection struct {
	Kind        string         `json:"kind"`
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Author      string         `json:"author,omitempty"`
	Version     string         `json:"version,omitempty"`
	Icon        string         `json:"icon,omitempty"`
	Tags        []string       `json:"tags,omitempty"`
	Sections    map[string]int `json:"sections"`
	Content     string         `json:"content"`
}

type moduleInspectRequest struct {
	URL     string `json:"url"`
	Content string `json:"content"`
}

func publicModuleTransport() *http.Transport {
	dialer := &net.Dialer{Timeout: 8 * time.Second}
	return &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			if len(ips) == 0 {
				return nil, errors.New("模块地址无法解析")
			}
			for _, item := range ips {
				if item.IP.IsLoopback() || item.IP.IsPrivate() || item.IP.IsLinkLocalUnicast() || item.IP.IsLinkLocalMulticast() || item.IP.IsUnspecified() || item.IP.IsMulticast() {
					return nil, errors.New("模块地址不能指向本地或私有网络")
				}
			}
			return dialer.DialContext(ctx, network, address)
		},
	}
}

func fetchModuleSource(ctx context.Context, rawURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", errors.New("请输入有效的 HTTP(S) 模块地址")
	}
	client := &http.Client{
		Timeout:   15 * time.Second,
		Transport: publicModuleTransport(),
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 || (req.URL.Scheme != "http" && req.URL.Scheme != "https") {
				return errors.New("模块重定向不被允许")
			}
			return nil
		},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "text/plain, application/yaml, text/yaml, */*;q=0.1")
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("拉取模块失败：%w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return "", fmt.Errorf("模块服务器返回 %s", response.Status)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil || len(body) >= 2<<20 {
		return "", errors.New("模块内容超过 2MB 限制或读取失败")
	}
	if strings.TrimSpace(string(body)) == "" {
		return "", errors.New("模块内容为空")
	}
	return string(body), nil
}

func countLoonSection(lines []string) int {
	count := 0
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") && !strings.HasPrefix(line, ";") {
			count++
		}
	}
	return count
}

func inspectLoonModule(content string) (*ModuleInspection, bool) {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	metadata := map[string]string{}
	sections := map[string]int{}
	current := ""
	seenSignal := false
	invalid := ""
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#!") {
			parts := strings.SplitN(strings.TrimPrefix(trimmed, "#!"), "=", 2)
			if len(parts) == 2 {
				metadata[strings.ToLower(strings.TrimSpace(parts[0]))] = strings.TrimSpace(parts[1])
				seenSignal = true
			}
			continue
		}
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			current = strings.ToLower(strings.TrimSpace(trimmed[1 : len(trimmed)-1]))
			if current == "general" || current == "rule" || current == "rewrite" || current == "url rewrite" || current == "host" || current == "script" || current == "mitm" || current == "argument" {
				seenSignal = true
			}
			continue
		}
		if current != "" {
			trimmedLine := strings.TrimSpace(line)
			if trimmedLine != "" && !strings.HasPrefix(trimmedLine, "#") && !strings.HasPrefix(trimmedLine, ";") {
				switch current {
				case "script":
					if !strings.Contains(strings.ToLower(trimmedLine), "script-path") || !strings.HasPrefix(strings.ToLower(trimmedLine), "http-request") && !strings.HasPrefix(strings.ToLower(trimmedLine), "http-response") && !strings.HasPrefix(strings.ToLower(trimmedLine), "cron") && !strings.HasPrefix(strings.ToLower(trimmedLine), "generic") && !strings.HasPrefix(strings.ToLower(trimmedLine), "network-changed") {
						invalid = "Loon [Script] 中存在缺少脚本类型或 script-path 的条目"
					}
				}
			}
			sections[current] += countLoonSection([]string{line})
		}
	}
	if invalid != "" {
		return nil, false
	}
	if !seenSignal {
		return nil, false
	}
	var tags []string
	for _, tag := range strings.Split(metadata["tag"], ",") {
		if tag = strings.TrimSpace(tag); tag != "" {
			tags = append(tags, tag)
		}
	}
	result := &ModuleInspection{Kind: "loon", Name: metadata["name"], Description: metadata["desc"], Author: metadata["author"], Version: metadata["version"], Icon: metadata["icon"], Tags: tags, Sections: map[string]int{}, Content: content}
	if result.Name == "" {
		result.Name = "Loon Plugin"
	}
	for source, target := range map[string]string{"general": "General", "rule": "Rule", "rewrite": "Rewrite", "url rewrite": "URL Rewrite", "host": "Host", "script": "Script", "mitm": "MITM", "argument": "Argument"} {
		if sections[source] > 0 {
			result.Sections[target] += sections[source]
		}
	}
	return result, true
}

func yamlEntryCount(value any) int {
	switch item := value.(type) {
	case []any:
		return len(item)
	case map[string]any:
		return len(item)
	case nil:
		return 0
	default:
		return 1
	}
}

func inspectEgernModule(content string) (*ModuleInspection, error) {
	var root map[string]any
	if err := yaml.Unmarshal([]byte(content), &root); err != nil || len(root) == 0 {
		return nil, errors.New("不是有效的 Egern YAML Module")
	}
	// These are the native module directive families. Aliases cover module
	// versions that use the singular form while keeping the output canonical.
	families := map[string][]string{
		"Rewrite": {"url_rewrites", "url_rewrite", "header_rewrites", "header_rewrite", "body_rewrites", "body_rewrite", "map_locals", "map_local"},
		"Script":  {"scriptings", "scripts", "script"},
		"MITM":    {"mitm"},
		"Rule":    {"rules", "rule"},
		"DNS":     {"dns", "dns_hijack", "dns_mappings"},
		"Capture": {"http_captures", "http_capture"},
		"Widget":  {"widgets", "widget"},
		"Network": {"bypass_tunnel_proxy", "real_ip_domains"},
	}
	sections := map[string]int{}
	for label, keys := range families {
		for _, key := range keys {
			if value, exists := root[key]; exists {
				sections[label] += yamlEntryCount(value)
			}
		}
	}
	name, _ := root["name"].(string)
	description, _ := root["description"].(string)
	if name == "" && description == "" && len(sections) == 0 {
		return nil, errors.New("YAML 不包含可识别的 Egern Module 元数据或指令")
	}
	author, _ := root["author"].(string)
	version, _ := root["version"].(string)
	icon, _ := root["icon"].(string)
	if name == "" {
		name = "Egern Module"
	}
	return &ModuleInspection{Kind: "egern", Name: name, Description: description, Author: author, Version: version, Icon: icon, Sections: sections, Content: content}, nil
}

func inspectModule(content string) (*ModuleInspection, error) {
	if result, ok := inspectLoonModule(content); ok {
		return result, nil
	}
	return inspectEgernModule(content)
}

// InspectModule fetches an optional public URL (or parses supplied content)
// and returns a normalized AST summary for the visual module editor.
func InspectModule(c *gin.Context) {
	var payload moduleInspectRequest
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "模块请求数据无效"})
		return
	}
	content := strings.TrimSpace(payload.Content)
	var err error
	if content == "" {
		content, err = fetchModuleSource(c.Request.Context(), payload.URL)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
			return
		}
	}
	result, err := inspectModule(content)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": "00000", "data": result, "msg": "ok"})
}
