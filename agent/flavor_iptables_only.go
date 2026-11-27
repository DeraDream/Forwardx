//go:build iptablesonly

package main

import (
	"os"
	"sort"
	"strconv"
	"strings"
)

// This build never runs the panel's standard Agent upgrade installer.
const iptablesOnlyBuild = true

// Versioned independently of the panel's standard Agent release.
var iptablesOnlyVersion = "dev"

func reportedAgentVersion() string { return Version + "-iptables-only." + iptablesOnlyVersion }

// Only ordinary kernel DNAT rules are accepted. In particular no service
// unit, tunnel, plugin, failover, or managed runtime may be provisioned.
func captureKernelActionRuntimeSnapshot(a action) localActionRuntimeSnapshot {
	if !allowKernelForwardAction(a) {
		return localActionRuntimeSnapshot{}
	}
	port := strconv.Itoa(a.SourcePort)
	_, _, protocol, hasProtocol := readTargetInfo(port)
	forwardType := readForwardTypeByPort(port)
	if forwardType != "iptables" && forwardType != "nftables" {
		return localActionRuntimeSnapshot{}
	}
	return localActionRuntimeSnapshot{
		valid: true, ruleID: readRuleIDByPort(port),
		forwardType: forwardType, protocol: protocol, hasProtocol: hasProtocol,
	}
}

func readKernelLocalRuntimeStatePayload() localRuntimeStatePayload {
	ruleStates := readLocalRuntimeRuleStates()
	ruleStates = mergeDesiredDisjointRuleStates(ruleStates, desiredRunningRuleStatesSnapshot())
	snapshot := newKernelForwardSnapshot()
	rules := make([]localRuntimeRuleState, 0, len(ruleStates))
	for _, state := range ruleStates {
		if state.ForwardType != "iptables" && state.ForwardType != "nftables" {
			continue
		}
		port := atoi(state.Port)
		if port <= 0 {
			continue
		}
		rules = append(rules, localRuntimeRuleState{
			Port: port, RuleID: state.RuleID, TunnelID: state.TunnelID,
			ForwardType: state.ForwardType, TargetIP: state.TargetIP,
			TargetPort: state.TargetPort, Protocol: state.Protocol,
			Ready: snapshot.localRuleStateReady(state),
		})
	}
	sort.Slice(rules, func(i, j int) bool {
		if rules[i].Port != rules[j].Port {
			return rules[i].Port < rules[j].Port
		}
		return rules[i].RuleID < rules[j].RuleID
	})
	return localRuntimeStatePayload{Rules: rules, Tunnels: []localRuntimeTunnelState{}, Services: []localRuntimeServiceState{}}
}

// Reconcile only locally owned kernel rules. Never stop services or erase a
// non-kernel runtime merely because an older panel sent unexpected state.
func syncKernelRunningRuleState(rules []runningRule, protectedPorts map[string]bool) {
	wanted := make(map[string]bool)
	for _, rule := range rules {
		if rule.RuleID > 0 && rule.SourcePort > 0 && (rule.ForwardType == "iptables" || rule.ForwardType == "nftables") {
			wanted[strconv.Itoa(rule.SourcePort)] = true
		}
	}
	files, err := os.ReadDir("/var/lib/forwardx-agent")
	if err != nil {
		return
	}
	for _, file := range files {
		name := file.Name()
		if !strings.HasPrefix(name, "port_") || !strings.HasSuffix(name, ".rule") {
			continue
		}
		port := strings.TrimSuffix(strings.TrimPrefix(name, "port_"), ".rule")
		kind := readForwardTypeByPort(port)
		if wanted[port] || (kind != "iptables" && kind != "nftables") {
			continue
		}
		ruleID := readRuleIDByPort(port)
		if _, found := desiredRunningRuleForStatePort(ruleID, atoi(port)); found {
			continue
		}
		ip, targetPort, protocol, known := readTargetInfo(port)
		if !known || protectedActionMatchesPort(protectedPorts, port, protocol) {
			continue
		}
		if kind == "nftables" {
			if ruleID <= 0 || !runShell(nftRuleCleanupCmd(ruleID)) {
				continue
			}
		} else {
			ok := true
			for _, command := range iptablesAgentTargetCleanupCmds(port, ip, targetPort, protocol) {
				ok = runShell(command) && ok
			}
			if !ok {
				continue
			}
		}
		for _, command := range countingRuleCleanupCmds(atoi(port)) {
			_ = runShell(command)
		}
		removeStateByPort(port)
	}
}

func handleKernelForwardAction(cfg Config, a action, _ func()) bool {
	if !allowKernelForwardAction(a) {
		logf("kernel-only Agent rejected action status=%s type=%s", a.StatusType, a.ForwardType)
		reportActionStatus(cfg, a, false, "轻量 Agent 仅支持 iptables/nftables 规则")
		return false
	}
	if rejectAgentProbePortAction(cfg, a) {
		return false
	}
	if conflict := externalForwardConflict(a); conflict != "" {
		reportActionStatus(cfg, a, false, conflict)
		return false
	}
	if a.Op == "remove" && shouldSkipRemoveForReassignedPort(a) {
		return true
	}
	if a.Op == "apply" {
		cleanupKernelForwardPortBeforeApply(a)
	}
	ok := runShellBatch(a.Commands)
	if ok {
		ok = newKernelForwardSnapshot().desiredActionConsistent(a)
	}
	if ok {
		if a.Op == "apply" {
			writeState(a)
		} else {
			removeState(a.SourcePort)
		}
	}
	message := ""
	if !ok {
		message = "内核转发规则执行失败或防火墙状态不一致"
	}
	reportActionStatus(cfg, a, ok && a.Op == "apply", message)
	return ok
}

func allowKernelForwardAction(a action) bool {
	return (a.ForwardType == "iptables" || a.ForwardType == "nftables") &&
		(a.StatusType == "" || a.StatusType == "rule") &&
		(a.Op == "apply" || a.Op == "remove") && a.RuleID > 0 && a.SourcePort > 0 &&
		a.Fxp == nil && a.Failover == nil && a.WireGuard == nil && a.PluginID == "" &&
		a.Unit == "" && a.UnitExtra == "" && a.ServiceName == "" && a.ServiceNameExtra == "" &&
		len(a.ManagedConfigs) == 0 && len(a.PreCommands) == 0 && len(a.PostCommands) == 0 &&
		len(a.RollbackCommands) == 0 && len(a.RemovalCommands) == 0 && !a.ForceRuntimeSync
}
