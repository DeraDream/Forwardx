package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

func testProbeNonce() [16]byte {
	return [16]byte{0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff}
}

func TestAgentProbeProtocolMatchesPanelWireFormat(t *testing.T) {
	token := []byte("forwardx-test-token")
	nonce := testProbeNonce()
	expiresAt := time.Unix(1_730_000_060, 0)
	request := buildAgentProbeRequest(token, agentProbeTransportTCP, expiresAt, nonce)
	response := expectedAgentProbeResponse(token, agentProbeTransportTCP, nonce)
	if got := hex.EncodeToString(request); got != "465850310101000000000000671db4bc00112233445566778899aabbccddeeff0ba73b9117eabbf561c990361c72ea9d938ba52ed5d3daeda76a7587863b005d" {
		t.Fatalf("request wire format = %s", got)
	}
	if got := hex.EncodeToString(response); got != "465852310101000000112233445566778899aabbccddeeffbab224c6618162e247a91eda7f8707b5f3264f39b72353fd7cfe57f387b2ab6e" {
		t.Fatalf("response wire format = %s", got)
	}
	verified, ok := verifyAgentProbeRequest(token, agentProbeTransportTCP, request, time.Unix(1_730_000_001, 0))
	if !ok || !bytes.Equal(verified, response) {
		t.Fatal("valid probe request did not verify")
	}
	if _, ok := verifyAgentProbeRequest(token, agentProbeTransportUDP, request, time.Unix(1_730_000_001, 0)); ok {
		t.Fatal("TCP ticket verified as UDP")
	}
}

func TestAgentProbeServerHandlesTCPAndUDP(t *testing.T) {
	token := "probe-listener-test-token"
	server := startAgentProbeServer(0, token)
	t.Cleanup(func() { _ = server.Close() })
	status := currentAgentProbeStatus()
	if !status.TCPReady || !status.UDPReady || status.Port <= 0 {
		t.Fatalf("probe listener not ready: %+v", status)
	}

	nonce := testProbeNonce()
	expiresAt := time.Now().Add(time.Minute)

	tcpRequest := buildAgentProbeRequest([]byte(token), agentProbeTransportTCP, expiresAt, nonce)
	tcpExpected := expectedAgentProbeResponse([]byte(token), agentProbeTransportTCP, nonce)
	tcpConn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", portText(status.Port)), time.Second)
	if err != nil {
		t.Fatalf("dial TCP probe: %v", err)
	}
	_ = tcpConn.SetDeadline(time.Now().Add(time.Second))
	if _, err := tcpConn.Write(tcpRequest); err != nil {
		_ = tcpConn.Close()
		t.Fatalf("write TCP probe: %v", err)
	}
	tcpResponse := make([]byte, agentProbeResponseSize)
	if _, err := io.ReadFull(tcpConn, tcpResponse); err != nil {
		_ = tcpConn.Close()
		t.Fatalf("read TCP probe: %v", err)
	}
	_ = tcpConn.Close()
	if !bytes.Equal(tcpResponse, tcpExpected) {
		t.Fatal("unexpected TCP probe response")
	}

	udpRequest := buildAgentProbeRequest([]byte(token), agentProbeTransportUDP, expiresAt, nonce)
	udpExpected := expectedAgentProbeResponse([]byte(token), agentProbeTransportUDP, nonce)
	udpConn, err := net.DialTimeout("udp", net.JoinHostPort("127.0.0.1", portText(status.Port)), time.Second)
	if err != nil {
		t.Fatalf("dial UDP probe: %v", err)
	}
	_ = udpConn.SetDeadline(time.Now().Add(time.Second))
	if _, err := udpConn.Write(udpRequest); err != nil {
		_ = udpConn.Close()
		t.Fatalf("write UDP probe: %v", err)
	}
	udpResponse := make([]byte, agentProbeResponseSize)
	if _, err := io.ReadFull(udpConn, udpResponse); err != nil {
		_ = udpConn.Close()
		t.Fatalf("read UDP probe: %v", err)
	}
	_ = udpConn.Close()
	if !bytes.Equal(udpResponse, udpExpected) {
		t.Fatal("unexpected UDP probe response")
	}
}

func TestAgentLinkProbeTaskMeasuresAuthenticatedTCPAndUDP(t *testing.T) {
	token := "agent-link-task-test-token"
	server := startAgentProbeServer(0, token)
	t.Cleanup(func() { _ = server.Close() })
	status := currentAgentProbeStatus()
	for _, transport := range []string{"tcp", "udp"} {
		transportCode := agentProbeTransportTCP
		if transport == "udp" {
			transportCode = agentProbeTransportUDP
		}
		attempts := make([]agentLinkProbeAttempt, 0, 3)
		for index := 0; index < 3; index++ {
			nonce := testProbeNonce()
			nonce[15] = byte(index)
			request := buildAgentProbeRequest([]byte(token), transportCode, time.Now().Add(time.Minute), nonce)
			response := expectedAgentProbeResponse([]byte(token), transportCode, nonce)
			attempts = append(attempts, agentLinkProbeAttempt{
				Request:          base64.StdEncoding.EncodeToString(request),
				ExpectedResponse: base64.StdEncoding.EncodeToString(response),
			})
		}
		now := time.Now()
		result := runAgentLinkProbeTaskAt(agentLinkProbeTask{
			TaskID:        "task-" + transport,
			EdgeKey:       "edge-" + transport,
			ProbeRoundID:  "round-1",
			ProbeVersion:  agentProbeProtocolVersion,
			TargetHostID:  2,
			TargetAddress: "127.0.0.1",
			TargetPort:    status.Port,
			Transport:     transport,
			TimeoutMS:     1000,
			Attempts:      attempts,
			CreatedAt:     now.UnixMilli(),
			ExpiresAt:     now.Add(time.Minute).UnixMilli(),
		}, now)
		if result.ProbeSuccesses != len(attempts) || result.LatencyMS == nil {
			t.Fatalf("%s Agent Link task failed: %+v", transport, result)
		}
	}
}

func TestAgentProbePortRejectsRuntimeApply(t *testing.T) {
	cfg := Config{ProbePort: defaultAgentProbePort}
	if port := actionAgentProbePortConflict(action{Op: "apply", SourcePort: defaultAgentProbePort}, cfg.ProbePort); port != defaultAgentProbePort {
		t.Fatalf("reserved source port conflict = %d", port)
	}
	if port := actionAgentProbePortConflict(action{Op: "remove", SourcePort: defaultAgentProbePort}, cfg.ProbePort); port != 0 {
		t.Fatalf("remove action was rejected on reserved port: %d", port)
	}
	if port := actionAgentProbePortConflict(action{Op: "apply", SourcePort: defaultAgentProbePort + 1}, cfg.ProbePort); port != 0 {
		t.Fatalf("unrelated source port conflict = %d", port)
	}
}

func portText(port int) string {
	return strconv.Itoa(port)
}
