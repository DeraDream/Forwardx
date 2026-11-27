//go:build iptablesonly

package main

import (
	"errors"
	"time"
)

// Types retained for decoding older panels' payloads; the kernel-only build
// does not import or initialize a WireGuard implementation.
const forwardXWireGuardVersion = "v2"

type wireGuardPeerSpec struct {
	ID                  string `json:"id"`
	HostID              int    `json:"hostId"`
	PublicKey           string `json:"publicKey"`
	Address             string `json:"address"`
	EndpointHost        string `json:"endpointHost,omitempty"`
	EndpointPort        int    `json:"endpointPort,omitempty"`
	PersistentKeepalive int    `json:"persistentKeepalive,omitempty"`
}
type wireGuardSpec struct {
	TunnelID   int                 `json:"tunnelId"`
	Generation int                 `json:"generation,omitempty"`
	PrivateKey string              `json:"privateKey,omitempty"`
	PublicKey  string              `json:"publicKey,omitempty"`
	Address    string              `json:"address,omitempty"`
	ListenPort int                 `json:"listenPort,omitempty"`
	MTU        int                 `json:"mtu,omitempty"`
	Peers      []wireGuardPeerSpec `json:"peers,omitempty"`
}

type wireGuardProbeStatus uint8

const (
	wireGuardProbeSuccess wireGuardProbeStatus = iota
	wireGuardProbeTimeout
	wireGuardProbeNotReady
)

func wireGuardRuntimeIdentityReplacementRequired(int, *wireGuardSpec) bool { return false }
func wireGuardRuntimeReady(int, *wireGuardSpec) bool                       { return false }
func stopWireGuardRuntime(int)                                             {}
func applyWireGuardRuntime(wireGuardSpec) error                            { return errors.New("unsupported runtime") }
func wireGuardFXPProxiesReady(fxpSpec) bool                                { return false }
func prepareFXPWireGuard(fxpSpec, string) (fxpSpec, error) {
	return fxpSpec{}, errors.New("unsupported runtime")
}
func releaseWireGuardRuntimeRef(int, string) {}
func wireGuardTCPLatencyDetailed(int, string, int, time.Duration) (int, wireGuardProbeStatus) {
	return 0, wireGuardProbeNotReady
}
func wireGuardTCPLatency(int, string, int, time.Duration) (int, bool) { return 0, false }
func normalizeWireGuardSpec(spec wireGuardSpec) (wireGuardSpec, error) {
	return spec, errors.New("unsupported runtime")
}
func wireGuardSpecSignature(wireGuardSpec) string     { return "" }
func applyWireGuardRuntimeLocked(wireGuardSpec) error { return errors.New("unsupported runtime") }
