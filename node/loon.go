package node

import (
	"fmt"
	"net/url"
	"strings"
)

// EncodeLoon emits a Loon subscription file.
func EncodeLoon(urls []string, sqlconfig SqlConfig) (string, error) {
	proxies := make([]string, 0, len(urls))
	proxyNames := make([]string, 0, len(urls))
	for _, raw := range urls {
		link := strings.TrimSpace(raw)
		if link == "" {
			continue
		}
		scheme := strings.ToLower(strings.SplitN(link, "://", 2)[0])
		switch scheme {
		case "ss":
			proxy, name, err := loonShadowsocksProxy(link, sqlconfig.Udp)
			if err != nil {
				continue
			}
			proxies = append(proxies, proxy)
			proxyNames = append(proxyNames, name)
		case "ssr", "vmess", "vless", "trojan", "hysteria2", "hy2", "anytls":
			proxies = append(proxies, link)
			if name := loonProxyName(link); name != "" {
				proxyNames = append(proxyNames, name)
			}
		}
	}
	proxyNames = appendUniqueStringNames(nil, proxyNames)

	profile := "# Loon subscription\n[Proxy]\n"
	if source := strings.TrimSpace(sqlconfig.Loon); source != "" {
		data, err := ReadTemplateSource(source)
		if err != nil {
			return "", err
		}
		profile = string(data)
	}
	if !strings.Contains(profile, "[Proxy]") {
		return "", fmt.Errorf("Loon template must contain a [Proxy] section")
	}
	profile = replaceSurgeSection(profile, "Proxy", func(lines []string) []string {
		return injectLoonProxies(lines, proxies)
	})
	profile, err := renderLoonPolicyGroups(
		profile,
		proxyNames,
		loonProxyNames(profile),
		policyGroupRulesForTemplate(sqlconfig, sqlconfig.Loon),
	)
	if err != nil {
		return "", err
	}
	if strings.Contains(profile, "__LOON_") {
		return "", fmt.Errorf("Loon template has unresolved internal placeholders")
	}
	return profile, nil
}

// loonShadowsocksProxy converts the SS URI storage format to Loon's native
// full-configuration syntax. Loon can read URI nodes in a node subscription,
// but a remote full configuration imported with loon://import?sub= requires
// native [Proxy] entries.
func loonShadowsocksProxy(link string, udp bool) (string, string, error) {
	proxy, err := DecodeSSURL(link)
	if err != nil {
		return "", "", err
	}
	name := strings.TrimSpace(proxy.Name)
	if name == "" {
		return "", "", fmt.Errorf("Loon Shadowsocks proxy has no name")
	}
	return fmt.Sprintf(
		"%s = Shadowsocks,%s,%d,%s,%q,udp=%t",
		name,
		proxy.Server,
		proxy.Port,
		proxy.Param.Cipher,
		proxy.ClientPassword(),
		udp,
	), name, nil
}

// loonProxyName returns the name Loon assigns to a URI proxy: its decoded
// fragment. Keep this next to the URI injection so group members always refer
// to exactly the proxies emitted in [Proxy].
func loonProxyName(link string) string {
	parsed, err := url.Parse(link)
	if err == nil && parsed.Fragment != "" {
		return strings.TrimSpace(parsed.Fragment)
	}
	if index := strings.LastIndex(link, "#"); index >= 0 && index+1 < len(link) {
		name, err := url.QueryUnescape(link[index+1:])
		if err == nil {
			return strings.TrimSpace(name)
		}
		return strings.TrimSpace(link[index+1:])
	}
	return ""
}

func injectLoonProxies(lines, proxies []string) []string {
	entries := strings.Join(proxies, "\n")
	replaced := false
	output := make([]string, 0, len(lines)+len(proxies))
	for _, line := range lines {
		if !strings.Contains(line, "__LOON_PROXY_ENTRIES__") {
			output = append(output, line)
			continue
		}
		replaced = true
		if entries != "" {
			output = append(output, strings.Split(strings.ReplaceAll(line, "__LOON_PROXY_ENTRIES__", entries), "\n")...)
		}
	}
	if !replaced && entries != "" {
		output = append(proxies, output...)
	}
	return output
}

func loonProxyNames(profile string) []string {
	names := []string{}
	replaceSurgeSection(profile, "Proxy", func(lines []string) []string {
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, ";") {
				continue
			}
			if name := loonProxyName(trimmed); name != "" {
				names = appendUniqueStringNames(names, []string{name})
				continue
			}
			// Loon also permits native `name = protocol, ...` proxy entries.
			// A URI may contain '=' in its query, so only use a left-hand side
			// for non-URI entries.
			if !strings.Contains(trimmed, "://") {
				if parts := strings.SplitN(trimmed, "=", 2); len(parts) == 2 {
					names = appendUniqueStringNames(names, []string{strings.TrimSpace(parts[0])})
				}
			}
		}
		return lines
	})
	return names
}

func renderLoonPolicyGroups(profile string, proxyNames, existingProxyNames []string, rules map[string]PolicyGroupNodeRule) (string, error) {
	groupNames := loonPolicyGroupNames(profile)
	dynamicGroup := false
	profile = replaceSurgeSection(profile, "Proxy Group", func(lines []string) []string {
		for i, line := range lines {
			if strings.Contains(line, "__LOON_ALL_NODES__") {
				dynamicGroup = true
				groupName := ""
				if parts := strings.SplitN(line, "=", 2); len(parts) == 2 {
					groupName = strings.TrimSpace(parts[0])
				}
				selected := selectedProxyNamesForGroup(groupName, proxyNames, rules)
				line = strings.ReplaceAll(line, "__LOON_ALL_NODES__", strings.Join(selected, ","))
			}
			lines[i] = validateLoonPolicyGroupLine(line, existingProxyNames, groupNames)
		}
		return lines
	})
	if dynamicGroup && len(proxyNames) == 0 {
		return "", fmt.Errorf("Loon policy groups require at least one proxy")
	}
	return profile, nil
}

func loonPolicyGroupNames(profile string) map[string]bool {
	names := make(map[string]bool)
	replaceSurgeSection(profile, "Proxy Group", func(lines []string) []string {
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, ";") {
				continue
			}
			if parts := strings.SplitN(line, "=", 2); len(parts) == 2 && strings.TrimSpace(parts[0]) != "" {
				names[strings.TrimSpace(parts[0])] = true
			}
		}
		return lines
	})
	return names
}

func validateLoonPolicyGroupLine(line string, proxyNames []string, groupNames map[string]bool) string {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, ";") {
		return line
	}
	parts := strings.SplitN(line, "=", 2)
	if len(parts) != 2 {
		return line
	}
	items := splitSurgeCSV(parts[1])
	if len(items) == 0 || !isSurgeInjectableGroupType(strings.TrimSpace(items[0])) {
		return strings.TrimSpace(line)
	}
	valid := make(map[string]bool, len(proxyNames)+len(groupNames)+2)
	for _, name := range proxyNames {
		valid[name] = true
	}
	for name := range groupNames {
		valid[name] = true
	}
	valid["DIRECT"] = true
	valid["REJECT"] = true

	members := []string{strings.TrimSpace(items[0])}
	parameters := make([]string, 0, len(items))
	for _, item := range items[1:] {
		item = strings.TrimSpace(item)
		if isSurgePolicyGroupParameter(item) {
			parameters = append(parameters, item)
		} else if valid[item] {
			members = appendUniqueStringNames(members, []string{item})
		}
	}
	return strings.TrimSpace(parts[0]) + " = " + strings.Join(append(members, parameters...), ",")
}
