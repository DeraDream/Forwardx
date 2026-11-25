//go:build iptablesonly

package main

import (
	"strings"
	"testing"
)

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
