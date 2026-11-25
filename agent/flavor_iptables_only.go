//go:build iptablesonly

package main

// This build never runs the panel's standard Agent upgrade installer.
const iptablesOnlyBuild = true

// Versioned independently of the panel's standard Agent release.
var iptablesOnlyVersion = "dev"

func reportedAgentVersion() string { return Version + "-iptables-only." + iptablesOnlyVersion }
