package node

import (
	"encoding/base64"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

type ServerReplacement struct {
	Protocol     string `json:"protocol"`
	OriginalHost string `json:"original_host"`
	Port         int    `json:"port"`
	Link         string `json:"link"`
}

// ReplaceServerAddress validates an SS or VLESS link and replaces only the
// connection host. Credentials, query parameters and remarks are preserved.
func ReplaceServerAddress(rawLink, targetIP string) (ServerReplacement, error) {
	rawLink = strings.TrimSpace(rawLink)
	if rawLink == "" {
		return ServerReplacement{}, fmt.Errorf("节点链接不能为空")
	}

	normalizedIP, err := NormalizeIPAddress(targetIP)
	if err != nil {
		return ServerReplacement{}, err
	}

	schemeEnd := strings.Index(rawLink, "://")
	if schemeEnd <= 0 {
		return ServerReplacement{}, fmt.Errorf("节点链接缺少协议头")
	}
	protocol := strings.ToLower(rawLink[:schemeEnd])
	switch protocol {
	case "ss":
		return replaceSSServer(rawLink, normalizedIP)
	case "vless":
		return replaceURLServer(rawLink, normalizedIP, protocol)
	default:
		return ServerReplacement{}, fmt.Errorf("仅支持 SS 和 VLESS 链接")
	}
}

func NormalizeIPAddress(value string) (string, error) {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		value = strings.TrimSuffix(strings.TrimPrefix(value, "["), "]")
	}
	ip := net.ParseIP(value)
	if ip == nil {
		return "", fmt.Errorf("入口地址必须是有效的 IPv4 或 IPv6")
	}
	return ip.String(), nil
}

func replaceSSServer(rawLink, targetIP string) (ServerReplacement, error) {
	rest := rawLink[len("ss://"):]
	payloadEnd := strings.IndexAny(rest, "?#")
	if payloadEnd < 0 {
		payloadEnd = len(rest)
	}
	payload := rest[:payloadEnd]
	suffix := rest[payloadEnd:]
	if payload == "" {
		return ServerReplacement{}, fmt.Errorf("SS 链接内容不能为空")
	}

	// SIP002: ss://userinfo@host:port?...#...
	if at := strings.LastIndex(payload, "@"); at >= 0 {
		if _, err := DecodeSSURL(rawLink); err != nil {
			return ServerReplacement{}, fmt.Errorf("SS 链接格式不正确: %w", err)
		}
		host, port, err := parseEndpoint(payload[at+1:])
		if err != nil {
			return ServerReplacement{}, fmt.Errorf("SS 服务器地址不正确: %w", err)
		}
		replaced := "ss://" + payload[:at+1] + net.JoinHostPort(targetIP, strconv.Itoa(port)) + suffix
		return ServerReplacement{Protocol: "ss", OriginalHost: host, Port: port, Link: replaced}, nil
	}

	// Legacy format: ss://base64(method:password@host:port)?...#...
	decoded, encoding, padded, err := decodeSSPayload(payload)
	if err != nil {
		return ServerReplacement{}, err
	}
	at := strings.LastIndex(decoded, "@")
	if at <= 0 || at == len(decoded)-1 {
		return ServerReplacement{}, fmt.Errorf("SS Base64 内容缺少认证信息或服务器地址")
	}
	if _, _, err := decodeSSAuth(decoded[:at]); err != nil {
		return ServerReplacement{}, fmt.Errorf("SS 认证信息不正确: %w", err)
	}
	host, port, err := parseEndpoint(decoded[at+1:])
	if err != nil {
		return ServerReplacement{}, fmt.Errorf("SS 服务器地址不正确: %w", err)
	}
	newPayload := decoded[:at+1] + net.JoinHostPort(targetIP, strconv.Itoa(port))
	replaced := "ss://" + encodeSSPayload(newPayload, encoding, padded) + suffix
	return ServerReplacement{Protocol: "ss", OriginalHost: host, Port: port, Link: replaced}, nil
}

func replaceURLServer(rawLink, targetIP, protocol string) (ServerReplacement, error) {
	u, err := url.Parse(rawLink)
	if err != nil || strings.ToLower(u.Scheme) != protocol || u.Opaque != "" {
		return ServerReplacement{}, fmt.Errorf("VLESS 链接格式不正确")
	}
	if u.User == nil || strings.TrimSpace(u.User.Username()) == "" {
		return ServerReplacement{}, fmt.Errorf("VLESS 链接缺少用户信息")
	}

	authorityStart := len(protocol) + 3
	authorityEnd := len(rawLink)
	if index := strings.IndexAny(rawLink[authorityStart:], "/?#"); index >= 0 {
		authorityEnd = authorityStart + index
	}
	authority := rawLink[authorityStart:authorityEnd]
	at := strings.LastIndex(authority, "@")
	if at <= 0 || at == len(authority)-1 {
		return ServerReplacement{}, fmt.Errorf("VLESS 链接缺少服务器地址")
	}
	host, port, err := parseEndpoint(authority[at+1:])
	if err != nil {
		return ServerReplacement{}, fmt.Errorf("VLESS 服务器地址不正确: %w", err)
	}
	replacedAuthority := authority[:at+1] + net.JoinHostPort(targetIP, strconv.Itoa(port))
	replaced := rawLink[:authorityStart] + replacedAuthority + rawLink[authorityEnd:]
	return ServerReplacement{Protocol: protocol, OriginalHost: host, Port: port, Link: replaced}, nil
}

func parseEndpoint(value string) (string, int, error) {
	host, portText, err := net.SplitHostPort(value)
	if err != nil {
		return "", 0, fmt.Errorf("必须使用 host:port 格式")
	}
	host = strings.TrimSpace(host)
	if host == "" || strings.ContainsAny(host, " /?#@") {
		return "", 0, fmt.Errorf("服务器地址为空或包含非法字符")
	}
	if net.ParseIP(host) == nil {
		if looksLikeIPv4(host) || !validHostname(host) {
			return "", 0, fmt.Errorf("服务器地址不是有效的 IP 或域名")
		}
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, fmt.Errorf("端口必须在 1-65535 之间")
	}
	return host, port, nil
}

func looksLikeIPv4(host string) bool {
	if !strings.Contains(host, ".") {
		return false
	}
	for _, char := range host {
		if (char < '0' || char > '9') && char != '.' {
			return false
		}
	}
	return true
}

func validHostname(host string) bool {
	if len(host) > 253 {
		return false
	}
	host = strings.TrimSuffix(host, ".")
	if host == "" {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, char := range label {
			if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '-' {
				return false
			}
		}
	}
	return true
}

type ssBase64Encoding int

const (
	ssBase64Std ssBase64Encoding = iota
	ssBase64URL
)

func decodeSSPayload(payload string) (string, ssBase64Encoding, bool, error) {
	padded := strings.HasSuffix(payload, "=")
	encoding := ssBase64Std
	if strings.ContainsAny(payload, "-_") {
		encoding = ssBase64URL
	}
	codecs := []*base64.Encoding{base64.RawStdEncoding, base64.StdEncoding}
	if encoding == ssBase64URL {
		codecs = []*base64.Encoding{base64.RawURLEncoding, base64.URLEncoding}
	}
	for _, codec := range codecs {
		decoded, err := codec.DecodeString(payload)
		if err == nil {
			return string(decoded), encoding, padded, nil
		}
	}
	return "", ssBase64Std, false, fmt.Errorf("SS Base64 内容无法解码")
}

func encodeSSPayload(value string, encoding ssBase64Encoding, padded bool) string {
	var codec *base64.Encoding
	if encoding == ssBase64URL {
		codec = base64.RawURLEncoding
	} else {
		codec = base64.RawStdEncoding
	}
	encoded := codec.EncodeToString([]byte(value))
	if padded {
		encoded += strings.Repeat("=", (4-len(encoded)%4)%4)
	}
	return encoded
}
