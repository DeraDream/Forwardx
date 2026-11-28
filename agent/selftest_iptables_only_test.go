//go:build iptablesonly

package main

import "testing"

func TestStandaloneAllowsOnlySingleTopologyTCPDial(t *testing.T) {
	valid := selfTest{TestID: 1, RuleID: 7, Kind: "topology-total", ForwardType: "topology-total",
		Method: "tcp", Protocol: "tcp", TargetIP: "192.0.2.1", TargetPort: 443}
	if !allowedIptablesOnlySelfTest(valid) {
		t.Fatal("topology total TCP test must be supported")
	}
	for _, mutate := range []func(*selfTest){
		func(v *selfTest) { v.Kind = "diagnostic-hop" },
		func(v *selfTest) { v.Kind = "forward-chain" },
		func(v *selfTest) { v.ForwardType = "iptables" },
		func(v *selfTest) { v.Method = "ping" },
		func(v *selfTest) { v.SourcePort = 443 },
		func(v *selfTest) { v.TargetPort = 0 },
		func(v *selfTest) { v.TunnelID = 3 },
	} {
		candidate := valid
		mutate(&candidate)
		if allowedIptablesOnlySelfTest(candidate) {
			t.Fatalf("unexpected unsupported job accepted: %+v", candidate)
		}
	}
}
