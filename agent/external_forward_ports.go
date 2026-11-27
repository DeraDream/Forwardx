package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// External DNAT is never owned by ForwardX, even if it points to the same target.
// Unknown/failed inspections are deliberately not treated as an empty ruleset.
type externalForwardPortsReport struct {
	Ports []externalForwardPort `json:"ports"`
	Error string                `json:"error,omitempty"`
}
type externalForwardPort struct {
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
	Owner    string `json:"owner"`
}

var externalIptablesDport = regexp.MustCompile(`(?:^| )--dport ([0-9]+)(?: |$)`)

func externalForwardPorts() externalForwardPortsReport {
	result := externalForwardPortsReport{Ports: []externalForwardPort{}}
	seen := map[string]bool{}
	ownNftRules := map[string]int{}
	ownIptablesRules := map[string]int{}
	add := func(port int, proto, owner string) {
		if port < 1 || port > 65535 {
			return
		}
		key := fmt.Sprintf("%d/%s/%s", port, proto, owner)
		if !seen[key] {
			seen[key] = true
			result.Ports = append(result.Ports, externalForwardPort{port, proto, owner})
		}
	}
	nftRulesLoaded := commandExists("nft")
	if nftRulesLoaded {
		raw, err := commandOutputWithTimeout(5*time.Second, "nft", "-j", "list", "ruleset")
		if err != nil {
			result.Error = "nft ruleset unavailable"
			return result
		}
		var document struct {
			Nftables []map[string]json.RawMessage `json:"nftables"`
		}
		if err := json.Unmarshal(raw, &document); err != nil || document.Nftables == nil {
			result.Error = "nft ruleset invalid"
			return result
		}
		for _, item := range document.Nftables {
			rawRule, exists := item["rule"]
			if !exists {
				continue
			}
			var rule struct {
				Family string                       `json:"family"`
				Table  string                       `json:"table"`
				Expr   []map[string]json.RawMessage `json:"expr"`
			}
			if json.Unmarshal(rawRule, &rule) != nil {
				result.Error = "nft rule invalid"
				return result
			}
			if rule.Family == "inet" && rule.Table == "forwardx" {
				continue
			}
			nat := false
			var dnatTarget json.RawMessage
			for _, expr := range rule.Expr {
				if expr["dnat"] != nil {
					nat = true
					dnatTarget = expr["dnat"]
				}
				if expr["redirect"] != nil {
					nat = true
				}
			}
			if !nat {
				continue
			}
			matched := false
			for _, expr := range rule.Expr {
				rawMatch := expr["match"]
				if rawMatch == nil {
					continue
				}
				var match struct {
					Left struct {
						Payload struct {
							Protocol string `json:"protocol"`
							Field    string `json:"field"`
						} `json:"payload"`
					} `json:"left"`
					Op    string          `json:"op"`
					Right json.RawMessage `json:"right"`
				}
				if json.Unmarshal(rawMatch, &match) != nil {
					result.Error = "nft match invalid"
					return result
				}
				proto := match.Left.Payload.Protocol
				if match.Left.Payload.Field != "dport" || (proto != "tcp" && proto != "udp") {
					continue
				}
				matched = true
				if match.Op != "==" {
					result.Error = "unsupported nft destination-port selector"
					return result
				}
				var port int
				if json.Unmarshal(match.Right, &port) == nil && port >= 1 && port <= 65535 {
					if (rule.Family == "ip" || rule.Family == "ip6") && rule.Table == "nat" && forwardxNftCompatDnat(port, proto, dnatTarget) {
						key := fmt.Sprintf("%s/%d/%s", rule.Family, port, proto)
						ownNftRules[key]++
						if ownNftRules[key] == 1 {
							continue
						}
					}
					add(port, proto, "nft")
					continue
				}
				// Conservative: do not claim a port is free when the rule uses a set/range/map.
				result.Error = "unsupported nft destination-port selector"
				return result
			}
			if !matched {
				result.Error = "nft DNAT without a simple destination port"
				return result
			}
		}
	}
	for _, binary := range iptablesAgentBinaries() {
		if !commandExists(binary) {
			continue
		}
		// iptables-nft rules are already present in the nft JSON ruleset. Avoid
		// dumping the same NAT chain twice on every interactive port check.
		// Legacy backends still need their own inspection.
		if nftRulesLoaded && iptablesUsesNftBackend(binary) {
			continue
		}
		raw, err := commandOutputWithTimeout(5*time.Second, binary, "-t", "nat", "-S", "PREROUTING")
		if err != nil {
			result.Error = binary + " nat rules unavailable"
			return result
		}
		for _, line := range strings.Split(string(raw), "\n") {
			if !strings.HasPrefix(line, "-A PREROUTING ") || !strings.Contains(line, "-j DNAT") {
				continue
			}
			match := externalIptablesDport.FindStringSubmatch(line)
			if len(match) != 2 {
				result.Error = binary + " DNAT selector unsupported"
				return result
			}
			port, _ := strconv.Atoi(match[1])
			proto := ""
			if strings.Contains(line, "-p tcp ") {
				proto = "tcp"
			} else if strings.Contains(line, "-p udp ") {
				proto = "udp"
			}
			if proto == "" {
				result.Error = binary + " DNAT protocol unsupported"
				return result
			}
			// Only the actual local ForwardX rule (same ID, port, protocol and target)
			// may be replaced. A foreign DNAT on the same port remains a conflict.
			if forwardxIptablesDnatLine(line, port, proto) {
				key := fmt.Sprintf("%s/%d/%s", binary, port, proto)
				ownIptablesRules[key]++
				if ownIptablesRules[key] == 1 {
					continue
				}
			}
			add(port, proto, binary)
		}
	}
	return result
}

func iptablesNftVersionOutput(text string) bool {
	return strings.Contains(strings.ToLower(text), "nf_tables")
}

func iptablesUsesNftBackend(binary string) bool {
	version, err := commandOutputWithTimeout(2*time.Second, binary, "-V")
	return err == nil && iptablesNftVersionOutput(string(version))
}

func forwardxNftCompatDnat(port int, proto string, raw json.RawMessage) bool {
	if len(raw) == 0 || readRuleIDByPort(strconv.Itoa(port)) <= 0 || readForwardTypeByPort(strconv.Itoa(port)) != "iptables" {
		return false
	}
	var target struct {
		Addr string `json:"addr"`
		Port int    `json:"port"`
	}
	if json.Unmarshal(raw, &target) != nil {
		return false
	}
	ip, targetPort, protocol, ok := readTargetInfo(strconv.Itoa(port))
	return ok && runtimeProtocolsOverlap(protocol, proto) && strings.Trim(ip, "[]") == strings.Trim(target.Addr, "[]") && targetPort == target.Port
}

func forwardxIptablesDnatLine(line string, port int, proto string) bool {
	portText := strconv.Itoa(port)
	if readRuleIDByPort(portText) <= 0 || readForwardTypeByPort(portText) != "iptables" {
		return false
	}
	ip, targetPort, protocol, ok := readTargetInfo(portText)
	if !ok || !runtimeProtocolsOverlap(protocol, proto) {
		return false
	}
	target := strings.Trim(ip, "[]") + ":" + strconv.Itoa(targetPort)
	if strings.Contains(ip, ":") {
		target = "[" + strings.Trim(ip, "[]") + "]:" + strconv.Itoa(targetPort)
	}
	fields := strings.Fields(line)
	for i := 0; i+1 < len(fields); i++ {
		if fields[i] == "--to-destination" && fields[i+1] == target {
			return true
		}
	}
	return false
}

func externalForwardConflict(a action) string {
	if !iptablesOnlyBuild || (a.Op != "apply" && a.Op != "remove") || a.SourcePort <= 0 || (a.ForwardType != "iptables" && a.ForwardType != "nftables") {
		return ""
	}
	report := externalForwardPorts()
	if report.Error != "" {
		return "cannot verify external forwarding: " + report.Error
	}
	for _, port := range report.Ports {
		if port.Port == a.SourcePort && runtimeProtocolsOverlap(port.Protocol, a.Protocol) {
			return fmt.Sprintf("port %d/%s occupied by external %s DNAT", port.Port, port.Protocol, port.Owner)
		}
	}
	return ""
}

type externalPortCheckRequest struct {
	RequestID string `json:"requestId"`
	Port      int    `json:"port"`
	Protocol  string `json:"protocol"`
}

func handleExternalPortCheck(cfg Config, request externalPortCheckRequest) {
	if len(request.RequestID) != 36 || request.Port < 1 || request.Port > 65535 || (request.Protocol != "tcp" && request.Protocol != "udp" && request.Protocol != "both") {
		return
	}
	started := time.Now()
	report := externalForwardPorts()
	conflict := ""
	if report.Error == "" {
		for _, item := range report.Ports {
			if item.Port == request.Port && runtimeProtocolsOverlap(item.Protocol, request.Protocol) {
				conflict = fmt.Sprintf("%d/%s (%s DNAT)", item.Port, item.Protocol, item.Owner)
				break
			}
		}
	}
	result := map[string]any{"requestId": request.RequestID, "error": report.Error, "conflict": conflict}
	err := post(cfg, "/api/agent/external-port-check-result", result, &map[string]any{})
	logf("external port check port=%d protocol=%s conflict=%s inspectionError=%s duration=%s reportOK=%v", request.Port, request.Protocol, conflict, report.Error, time.Since(started).Round(time.Millisecond), err == nil)
	if err != nil && shouldLogAgentReport("external-port-check-result", agentReportLogInterval) {
		logAgentCommError("external-port-check-result", err)
	}
}
