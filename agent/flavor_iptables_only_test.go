//go:build iptablesonly

package main

import (
	"strings"
	"testing"
)

func TestKernelOnlyActionGate(t *testing.T) {
	base := action{Op: "apply", RuleID: 1, SourcePort: 20001, ForwardType: "iptables"}
	for _, forwardType := range []string{"iptables", "nftables"} {
		candidate := base
		candidate.ForwardType = forwardType
		if !allowKernelForwardAction(candidate) {
			t.Fatalf("kernel rule rejected: %s", forwardType)
		}
		candidate.Op = "remove"
		if !allowKernelForwardAction(candidate) {
			t.Fatalf("kernel removal rejected: %s", forwardType)
		}
	}
	for _, mutate := range []func(*action){
		func(a *action) { a.ForwardType = "gost" },
		func(a *action) { a.StatusType = "runtime" },
		func(a *action) { a.Unit = "[Service]" },
		func(a *action) { a.PreCommands = []string{"install"} },
		func(a *action) { a.PluginID = "plugin" },
		func(a *action) { a.Failover = &failoverSpec{} },
	} {
		candidate := base
		mutate(&candidate)
		if allowKernelForwardAction(candidate) {
			t.Fatalf("non-kernel action accepted: %+v", candidate)
		}
	}
}

func TestIptablesOnlyBuildNeverStartsPanelUpgrade(t *testing.T) {
	if !iptablesOnlyBuild {
		t.Fatal("iptables-only build flag is not enabled")
	}
	if !strings.HasPrefix(reportedAgentVersion(), Version+"-iptables-only.") {
		t.Fatal("standalone Agent must identify itself separately to the panel")
	}
	// A standard panel upgrade would otherwise start an installer subprocess.
	selfUpgrade(Config{}, &agentUpgrade{TargetVersion: "9999.0.0"})
	if upgradeStarted != 0 {
		t.Fatal("iptables-only Agent accepted the standard upgrade")
	}
}
