//go:build !iptablesonly

package main

const iptablesOnlyBuild = false

const iptablesOnlyVersion = ""

func reportedAgentVersion() string { return Version }
