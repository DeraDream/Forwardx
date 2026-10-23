package node

import (
	"fmt"
	"log"
	"strings"
)

func EncodeSurge(urls []string, sqlconfig SqlConfig) (string, error) {
	var proxys, groups []string
	for _, link := range urls {
		Scheme := strings.Split(link, "://")[0]
		switch {
		case Scheme == "ss":
			ss, err := DecodeSSURL(link)
			if err != nil {
				log.Println(err)
				continue
			}
			proxy := map[string]interface{}{
				"name":     ss.Name,
				"server":   ss.Server,
				"port":     ss.Port,
				"cipher":   ss.Param.Cipher,
				"password": ss.ClientPassword(),
				"udp":      sqlconfig.Udp,
			}
			ssproxy := fmt.Sprintf("%s = ss, %s, %d, encrypt-method=%s, password=%s, udp-relay=%t",
				proxy["name"], proxy["server"], proxy["port"], proxy["cipher"], proxy["password"], proxy["udp"])
			groups = append(groups, ss.Name)
			proxys = append(proxys, ssproxy)
		case Scheme == "vmess":
			vmess, err := DecodeVMESSURL(link)
			if err != nil {
				log.Println(err)
				continue
			}
			tls := false
			if vmess.Tls != "none" && vmess.Tls != "" {
				tls = true
			}
			port, err := convertToInt(vmess.Port)
			if err != nil || port <= 0 {
				log.Println("invalid vmess port")
				continue
			}
			proxy := map[string]interface{}{
				"name":             vmess.Ps,
				"server":           vmess.Add,
				"port":             port,
				"uuid":             vmess.Id,
				"tls":              tls,
				"network":          vmess.Net,
				"ws-path":          vmess.Path,
				"ws-host":          vmess.Host,
				"udp":              sqlconfig.Udp,
				"skip-cert-verify": sqlconfig.Cert,
			}
			vmessproxy := fmt.Sprintf("%s = vmess, %s, %d, username=%s , tls=%t, vmess-aead=true,  udp-relay=%t , skip-cert-verify=%t",
				proxy["name"], proxy["server"], proxy["port"], proxy["uuid"], proxy["tls"], proxy["udp"], proxy["skip-cert-verify"])
			if vmess.Net == "ws" {
				vmessproxy = fmt.Sprintf("%s, ws=true,ws-path=%s", vmessproxy, proxy["ws-path"])
				if vmess.Host != "" && vmess.Host != "none" {
					vmessproxy = fmt.Sprintf("%s, ws-headers=Host:%s", vmessproxy, proxy["ws-host"])
				}
			}
			if vmess.Sni != "" {
				vmessproxy = fmt.Sprintf("%s, sni=%s", vmessproxy, vmess.Sni)
			}
			groups = append(groups, vmess.Ps)
			proxys = append(proxys, vmessproxy)
		case Scheme == "trojan":
			trojan, err := DecodeTrojanURL(link)
			if err != nil {
				log.Println(err)
				continue
			}
			proxy := map[string]interface{}{
				"name":             trojan.Name,
				"server":           trojan.Hostname,
				"port":             trojan.Port,
				"password":         trojan.Password,
				"udp":              sqlconfig.Udp,
				"skip-cert-verify": sqlconfig.Cert,
			}
			trojanproxy := fmt.Sprintf("%s = trojan, %s, %d, password=%s, udp-relay=%t, skip-cert-verify=%t",
				proxy["name"], proxy["server"], proxy["port"], proxy["password"], proxy["udp"], proxy["skip-cert-verify"])
			if trojan.Query.Sni != "" {
				trojanproxy = fmt.Sprintf("%s, sni=%s", trojanproxy, trojan.Query.Sni)

			}
			groups = append(groups, trojan.Name)
			proxys = append(proxys, trojanproxy)
		case Scheme == "hysteria2" || Scheme == "hy2":
			hy2, err := DecodeHY2URL(link)
			if err != nil {
				log.Println(err)
				continue
			}
			proxy := map[string]interface{}{
				"name":             hy2.Name,
				"server":           hy2.Host,
				"port":             hy2.Port,
				"password":         hy2.Password,
				"udp":              sqlconfig.Udp,
				"skip-cert-verify": sqlconfig.Cert,
			}
			hy2proxy := fmt.Sprintf("%s = hysteria2, %s, %d, password=%s, udp-relay=%t, skip-cert-verify=%t",
				proxy["name"], proxy["server"], proxy["port"], proxy["password"], proxy["udp"], proxy["skip-cert-verify"])
			if hy2.Sni != "" {
				hy2proxy = fmt.Sprintf("%s, sni=%s", hy2proxy, hy2.Sni)

			}
			groups = append(groups, hy2.Name)
			proxys = append(proxys, hy2proxy)
		case Scheme == "tuic":
			tuic, err := DecodeTuicURL(link)
			if err != nil {
				log.Println(err)
				continue
			}
			proxy := map[string]interface{}{
				"name":             tuic.Name,
				"server":           tuic.Host,
				"port":             tuic.Port,
				"password":         tuic.Password,
				"udp":              sqlconfig.Udp,
				"skip-cert-verify": sqlconfig.Cert,
			}
			tuicproxy := fmt.Sprintf("%s = tuic, %s, %d, token=%s, udp-relay=%t, skip-cert-verify=%t",
				proxy["name"], proxy["server"], proxy["port"], proxy["password"], proxy["udp"], proxy["skip-cert-verify"])
			groups = append(groups, tuic.Name)
			proxys = append(proxys, tuicproxy)
		}
	}
	return DecodeSurge(proxys, groups, sqlconfig)
}
func DecodeSurge(proxys, groups []string, sqlconfig SqlConfig) (string, error) {
	surge, err := ReadTemplateSource(sqlconfig.Surge)
	if err != nil {
		log.Println(err)
		return "", err
	}

	proxyPart := replaceSurgeSection(string(surge), "Proxy", func(lines []string) []string {
		text := strings.Join(proxys, "\n")
		if strings.TrimSpace(text) == "" {
			return lines
		}
		return append(strings.Split(text, "\n"), lines...)
	})
	groupPart := replaceSurgeSection(proxyPart, "Proxy Group", func(lines []string) []string {
		for i, line := range lines {
			if strings.Contains(line, "=") {
				updatedLine, ok := injectSurgePolicyGroupLine(line, groups, policyGroupRulesForTemplate(sqlconfig, sqlconfig.Surge))
				if !ok {
					lines[i] = strings.TrimSpace(line)
					continue
				}
				lines[i] = updatedLine
			}
		}
		return lines
	})

	return groupPart, nil
}

func replaceSurgeSection(profile string, sectionName string, transform func([]string) []string) string {
	lines := strings.Split(profile, "\n")
	header := "[" + sectionName + "]"
	start := -1
	for i, line := range lines {
		if strings.TrimSpace(line) == header {
			start = i
			break
		}
	}
	if start < 0 {
		return profile
	}

	end := len(lines)
	for i := start + 1; i < len(lines); i++ {
		trimmed := strings.TrimSpace(lines[i])
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			end = i
			break
		}
	}

	next := make([]string, 0, len(lines))
	next = append(next, lines[:start+1]...)
	next = append(next, transform(append([]string(nil), lines[start+1:end]...))...)
	next = append(next, lines[end:]...)
	return strings.Join(next, "\n")
}

func injectSurgePolicyGroupLine(line string, proxyNames []string, rules map[string]PolicyGroupNodeRule) (string, bool) {
	trimmedLine := strings.TrimSpace(line)
	if trimmedLine == "" || strings.HasPrefix(trimmedLine, "#") || strings.HasPrefix(trimmedLine, ";") {
		return line, false
	}

	parts := strings.SplitN(line, "=", 2)
	if len(parts) != 2 {
		return line, false
	}
	groupName := strings.TrimSpace(parts[0])
	items := splitSurgeCSV(parts[1])
	if len(items) == 0 {
		return line, false
	}
	groupType := strings.TrimSpace(items[0])
	if !isSurgeInjectableGroupType(groupType) {
		return line, false
	}

	selected := selectedProxyNamesForGroup(groupName, proxyNames, rules)
	if len(selected) == 0 {
		return strings.TrimSpace(line), false
	}

	prefix := []string{groupType}
	existingPolicies := make([]string, 0, len(items))
	parameters := make([]string, 0, len(items))
	for _, item := range items[1:] {
		if isSurgePolicyGroupParameter(item) {
			parameters = append(parameters, strings.TrimSpace(item))
			continue
		}
		existingPolicies = append(existingPolicies, strings.TrimSpace(item))
	}
	mergedPolicies := appendUniqueStringNames(existingPolicies, selected)
	return groupName + " = " + strings.Join(append(append(prefix, mergedPolicies...), parameters...), ", "), true
}

func isSurgeInjectableGroupType(groupType string) bool {
	switch strings.TrimSpace(groupType) {
	case "select", "url-test", "fallback", "load-balance":
		return true
	default:
		return false
	}
}

func isSurgePolicyGroupParameter(item string) bool {
	item = strings.TrimSpace(item)
	if item == "" {
		return true
	}
	if strings.Contains(item, "=") {
		return true
	}
	switch item {
	case "no-alert", "hidden":
		return true
	default:
		return false
	}
}

func splitSurgeCSV(value string) []string {
	rawItems := strings.Split(value, ",")
	items := make([]string, 0, len(rawItems))
	for _, item := range rawItems {
		trimmed := strings.TrimSpace(item)
		if trimmed != "" {
			items = append(items, trimmed)
		}
	}
	return items
}
