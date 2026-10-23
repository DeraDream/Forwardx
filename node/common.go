package node

import (
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

type SqlConfig struct {
	OutputType                 string                         `json:"output_type"`
	Clash                      string                         `json:"clash"`
	Surge                      string                         `json:"surge"`
	Egern                      string                         `json:"egern"`
	Loon                       string                         `json:"loon"`
	EgernUpdateIntervalMinutes int                            `json:"egern_update_interval"`
	EgernUpdateURL             string                         `json:"-"`
	Udp                        bool                           `json:"udp"`
	Cert                       bool                           `json:"cert"`
	GroupNodes                 map[string]PolicyGroupNodeRule `json:"group_nodes"`
	GroupNodesTemplate         string                         `json:"group_nodes_template"`
}

type PolicyGroupNodeRule struct {
	Mode  string   `json:"mode"`
	Nodes []string `json:"nodes"`
}

func selectedProxyNamesForGroup(groupName string, allProxyNames []string, rules map[string]PolicyGroupNodeRule) []string {
	rule, ok := rules[groupName]
	if !ok || strings.TrimSpace(rule.Mode) == "" || rule.Mode == "all" {
		return allProxyNames
	}

	switch rule.Mode {
	case "none":
		return []string{}
	case "include":
		allowed := make(map[string]bool, len(rule.Nodes))
		for _, name := range rule.Nodes {
			trimmed := strings.TrimSpace(name)
			if trimmed != "" {
				allowed[trimmed] = true
			}
		}
		selected := make([]string, 0, len(rule.Nodes))
		for _, name := range allProxyNames {
			if allowed[name] {
				selected = append(selected, name)
			}
		}
		return selected
	default:
		return allProxyNames
	}
}

func policyGroupRulesForTemplate(sqlconfig SqlConfig, templateSource string) map[string]PolicyGroupNodeRule {
	configuredSource := strings.TrimSpace(sqlconfig.GroupNodesTemplate)
	if configuredSource != "" && configuredSource != strings.TrimSpace(templateSource) {
		return nil
	}
	return sqlconfig.GroupNodes
}

func appendUniqueProxyNames(existing []interface{}, names []string) []interface{} {
	seen := make(map[string]bool, len(existing)+len(names))
	valid := make([]interface{}, 0, len(existing)+len(names))
	for _, item := range existing {
		if item == nil {
			continue
		}
		if name, ok := item.(string); ok {
			seen[name] = true
		}
		valid = append(valid, item)
	}
	for _, name := range names {
		if strings.TrimSpace(name) == "" || seen[name] {
			continue
		}
		valid = append(valid, name)
		seen[name] = true
	}
	return valid
}

func appendUniqueStringNames(existing []string, names []string) []string {
	seen := make(map[string]bool, len(existing)+len(names))
	valid := make([]string, 0, len(existing)+len(names))
	for _, item := range existing {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}
		valid = append(valid, trimmed)
		seen[trimmed] = true
	}
	for _, name := range names {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		valid = append(valid, trimmed)
		seen[trimmed] = true
	}
	return valid
}

var templateHTTPClient = &http.Client{Timeout: 20 * time.Second}

func ReadTemplateSource(source string) ([]byte, error) {
	if !strings.Contains(source, "://") {
		return os.ReadFile(source)
	}

	request, err := http.NewRequest(http.MethodGet, source, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Cache-Control", "no-cache, no-store, max-age=0")
	request.Header.Set("Pragma", "no-cache")
	response, err := templateHTTPClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("template request failed: %s", response.Status)
	}
	return io.ReadAll(response.Body)
}

// ipv6地址匹配规则
func ValRetIPv6Addr(s string) string {
	pattern := `\[([0-9a-fA-F:]+)\]`
	re := regexp.MustCompile(pattern)
	match := re.FindStringSubmatch(s)
	if len(match) > 0 {
		return match[1]
	} else {
		return s
	}
}

// 判断是否需要补全
func IsBase64makeup(s string) string {
	l := len(s)
	if l%4 != 0 {
		return s + strings.Repeat("=", 4-l%4)
	}
	return s
}

// base64编码
func Base64Encode(s string) string {
	return base64.StdEncoding.EncodeToString([]byte(s))
}

// base64解码
func Base64Decode(s string) string {
	// 去除空格
	s = strings.ReplaceAll(s, " ", "")
	// 判断是否有特殊字符来判断是标准base64还是url base64
	match, err := regexp.MatchString(`[_-]`, s)
	if err != nil {
		fmt.Println(err)
	}
	if !match {
		// 默认使用标准解码
		encoded := IsBase64makeup(s)
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return s // 返回原字符串
		}
		decoded_str := string(decoded)
		return decoded_str

	} else {
		// 如果有特殊字符则使用URL解码
		encoded := IsBase64makeup(s)
		decoded, err := base64.URLEncoding.DecodeString(encoded)
		if err != nil {
			return s // 返回原字符串
		}
		decoded_str := string(decoded)
		return decoded_str
	}
}

// base64解码不自动补齐
func Base64Decode2(s string) string {
	// 去除空格
	s = strings.ReplaceAll(s, " ", "")
	// 判断是否有特殊字符来判断是标准base64还是url base64
	match, err := regexp.MatchString(`[_-]`, s)
	if err != nil {
		fmt.Println(err)
	}
	if !match {
		// 默认使用标准解码
		decoded, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			return s // 返回原字符串
		}
		decoded_str := string(decoded)
		return decoded_str

	} else {
		// 如果有特殊字符则使用URL解码
		decoded, err := base64.URLEncoding.DecodeString(s)
		if err != nil {
			return s // 返回原字符串
		}
		decoded_str := string(decoded)
		return decoded_str
	}
}

// 检查环境
func CheckEnvironment() bool {
	APP_ENV := os.Getenv("APP_ENV")
	if APP_ENV == "" {
		// fmt.Println("APP_ENV环境变量未设置")
		return false
	}
	if strings.Contains(APP_ENV, "development") {
		// fmt.Println("你现在是开发环境")
		return true
	}
	// fmt.Println("你现在是生产环境")
	return false
}
