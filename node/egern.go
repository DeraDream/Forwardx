package node

import (
	"fmt"
	"log"
	"strings"

	"gopkg.in/yaml.v3"
)

const DefaultEgernUpdateIntervalMinutes = 1440

// EncodeEgern generates an Egern Profile.yaml independently from the Clash
// and Surge encoders. Only the existing URI parsers are shared.
func EncodeEgern(urls []string, sqlconfig SqlConfig) ([]byte, error) {
	proxies := make([]interface{}, 0, len(urls))
	proxyNames := make([]string, 0, len(urls))

	for _, link := range urls {
		proxy, name, err := encodeEgernProxy(strings.TrimSpace(link), sqlconfig)
		if err != nil {
			log.Println(err)
			continue
		}
		if proxy == nil {
			continue
		}
		proxies = append(proxies, proxy)
		proxyNames = append(proxyNames, name)
	}

	return decodeEgern(proxies, proxyNames, sqlconfig)
}

func encodeEgernProxy(link string, sqlconfig SqlConfig) (map[string]interface{}, string, error) {
	if link == "" || !strings.Contains(link, "://") {
		return nil, "", nil
	}

	switch strings.ToLower(strings.SplitN(link, "://", 2)[0]) {
	case "ss":
		ss, err := DecodeSSURL(link)
		if err != nil {
			return nil, "", err
		}
		return egernProxy("shadowsocks", map[string]interface{}{
			"name":      ss.Name,
			"method":    ss.Param.Cipher,
			"password":  ss.ClientPassword(),
			"server":    ss.Server,
			"port":      ss.Port,
			"tfo":       false,
			"udp_relay": sqlconfig.Udp,
		}), ss.Name, nil

	case "trojan":
		trojan, err := DecodeTrojanURL(link)
		if err != nil {
			return nil, "", err
		}
		config := map[string]interface{}{
			"name":            trojan.Name,
			"server":          trojan.Hostname,
			"port":            trojan.Port,
			"password":        trojan.Password,
			"tfo":             false,
			"udp_relay":       sqlconfig.Udp,
			"skip_tls_verify": sqlconfig.Cert,
		}
		if trojan.Query.Sni != "" {
			config["sni"] = trojan.Query.Sni
		}
		if strings.EqualFold(trojan.Query.Type, "ws") {
			websocket := map[string]interface{}{"path": trojan.Query.Path}
			if trojan.Query.Host != "" {
				websocket["host"] = trojan.Query.Host
			}
			config["websocket"] = websocket
		}
		return egernProxy("trojan", config), trojan.Name, nil

	case "vmess":
		vmess, err := DecodeVMESSURL(link)
		if err != nil {
			return nil, "", err
		}
		port, err := convertToInt(vmess.Port)
		if err != nil || port <= 0 {
			return nil, "", fmt.Errorf("invalid vmess port")
		}
		config := map[string]interface{}{
			"name":      vmess.Ps,
			"server":    vmess.Add,
			"port":      port,
			"user_id":   vmess.Id,
			"security":  vmess.Scy,
			"legacy":    false,
			"tfo":       false,
			"udp_relay": sqlconfig.Udp,
		}
		if transport := egernTransport(vmess.Net, vmess.Tls, vmess.Sni, vmess.Path, vmess.Host, sqlconfig.Cert); transport != nil {
			config["transport"] = transport
		}
		return egernProxy("vmess", config), vmess.Ps, nil

	case "vless":
		vless, err := DecodeVLESSURL(link)
		if err != nil {
			return nil, "", err
		}
		if strings.EqualFold(vless.Query.Security, "reality") {
			return nil, "", fmt.Errorf("Egern does not support VLESS Reality: %s", vless.Name)
		}
		config := map[string]interface{}{
			"name":      vless.Name,
			"server":    vless.Server,
			"port":      vless.Port,
			"user_id":   vless.Uuid,
			"tfo":       false,
			"udp_relay": sqlconfig.Udp,
		}
		if transport := egernTransport(vless.Query.Type, vless.Query.Security, vless.Query.Sni, vless.Query.Path, vless.Query.Host, sqlconfig.Cert); transport != nil {
			config["transport"] = transport
		}
		return egernProxy("vless", config), vless.Name, nil

	case "hy2", "hysteria2":
		hy2, err := DecodeHY2URL(link)
		if err != nil {
			return nil, "", err
		}
		auth := hy2.Auth
		if auth == "" {
			auth = hy2.Password
		}
		config := map[string]interface{}{
			"name":            hy2.Name,
			"server":          hy2.Host,
			"port":            hy2.Port,
			"auth":            auth,
			"skip_tls_verify": sqlconfig.Cert || hy2.Insecure == 1,
		}
		if hy2.Sni != "" {
			config["sni"] = hy2.Sni
		}
		if hy2.Obfs != "" {
			config["obfs"] = hy2.Obfs
		}
		if hy2.ObfsPassword != "" {
			config["obfs_password"] = hy2.ObfsPassword
		}
		return egernProxy("hysteria2", config), hy2.Name, nil

	case "tuic":
		tuic, err := DecodeTuicURL(link)
		if err != nil {
			return nil, "", err
		}
		relayMode := tuic.Udp_relay_mode
		if relayMode == "" {
			relayMode = "native"
		}
		config := map[string]interface{}{
			"name":            tuic.Name,
			"server":          tuic.Host,
			"port":            tuic.Port,
			"uuid":            tuic.Uuid,
			"password":        tuic.Password,
			"udp_relay_mode":  relayMode,
			"skip_tls_verify": sqlconfig.Cert,
		}
		if len(tuic.Alpn) > 0 {
			config["alpn"] = tuic.Alpn
		}
		if tuic.Sni != "" {
			config["sni"] = tuic.Sni
		}
		return egernProxy("tuic", config), tuic.Name, nil
	}

	// Egern does not support SSR or Hysteria 1.
	return nil, "", nil
}

func egernProxy(protocol string, config map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{protocol: config}
}

func egernTransport(network, security, sni, path, host string, skipTLSVerify bool) map[string]interface{} {
	network = strings.ToLower(strings.TrimSpace(network))
	security = strings.ToLower(strings.TrimSpace(security))

	switch network {
	case "ws":
		protocol := "ws"
		if security == "tls" {
			protocol = "wss"
		}
		config := map[string]interface{}{"path": path}
		if host != "" {
			config["headers"] = map[string]interface{}{"Host": host}
		}
		return map[string]interface{}{protocol: config}
	case "h2", "http2":
		config := map[string]interface{}{"method": "GET", "path": path}
		if host != "" {
			config["headers"] = map[string]interface{}{"Host": host}
		}
		return map[string]interface{}{"http2": config}
	case "http", "http1":
		config := map[string]interface{}{"method": "GET", "path": path}
		if host != "" {
			config["headers"] = map[string]interface{}{"Host": host}
		}
		return map[string]interface{}{"http1": config}
	}

	if security == "tls" {
		config := map[string]interface{}{"skip_tls_verify": skipTLSVerify}
		if sni != "" {
			config["sni"] = sni
		}
		return map[string]interface{}{"tls": config}
	}
	return nil
}

func decodeEgern(proxies []interface{}, proxyNames []string, sqlconfig SqlConfig) ([]byte, error) {
	template, err := ReadTemplateSource(sqlconfig.Egern)
	if err != nil {
		return nil, err
	}

	var config map[string]interface{}
	if err := yaml.Unmarshal(template, &config); err != nil {
		return nil, fmt.Errorf("invalid Egern template: %w", err)
	}
	if updateURL := strings.TrimSpace(sqlconfig.EgernUpdateURL); updateURL != "" {
		intervalMinutes := sqlconfig.EgernUpdateIntervalMinutes
		if intervalMinutes <= 0 {
			intervalMinutes = DefaultEgernUpdateIntervalMinutes
		}
		config["auto_update"] = map[string]interface{}{
			"url":      updateURL,
			"interval": int64(intervalMinutes) * 60,
		}
	}
	config["proxies"] = proxies

	groups, ok := config["policy_groups"].([]interface{})
	if !ok {
		return nil, fmt.Errorf("Egern template must contain a policy_groups list")
	}
	rules := policyGroupRulesForTemplate(sqlconfig, sqlconfig.Egern)
	for i, item := range groups {
		group, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		for groupType, rawSettings := range group {
			groupType = strings.TrimSpace(groupType)
			settings, ok := rawSettings.(map[string]interface{})
			if !ok {
				continue
			}
			if groupType == "external" {
				localType, _ := settings["type"].(string)
				localType = strings.TrimSpace(localType)
				if !isEgernLocalPolicyGroupType(localType) {
					continue
				}
				delete(settings, "type")
				delete(settings, "urls")
				delete(settings, "update_interval")
				delete(settings, "filter")
				groupType = localType
				group = map[string]interface{}{groupType: settings}
				groups[i] = group
			}
			if !isEgernLocalPolicyGroupType(groupType) {
				continue
			}
			name, _ := settings["name"].(string)
			selected := selectedProxyNamesForGroup(name, proxyNames, rules)
			existing, _ := settings["policies"].([]interface{})
			settings["policies"] = appendUniqueProxyNames(existing, selected)
		}
	}
	config["policy_groups"] = groups

	return yaml.Marshal(config)
}

func isEgernLocalPolicyGroupType(groupType string) bool {
	switch groupType {
	case "select", "auto_test", "smart", "fallback", "load_balance":
		return true
	default:
		return false
	}
}
