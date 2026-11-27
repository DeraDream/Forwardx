//go:build !iptablesonly

package main

const iptablesOnlyBuild = false

const iptablesOnlyVersion = ""

func reportedAgentVersion() string { return Version }

func allowKernelForwardAction(a action) bool { return true }

func handleKernelForwardAction(_ Config, _ action, _ func()) bool { return false }

func syncKernelRunningRuleState(_ []runningRule, _ map[string]bool) {}

func readKernelLocalRuntimeStatePayload() localRuntimeStatePayload { return localRuntimeStatePayload{} }

func captureKernelActionRuntimeSnapshot(action) localActionRuntimeSnapshot {
	return localActionRuntimeSnapshot{}
}
