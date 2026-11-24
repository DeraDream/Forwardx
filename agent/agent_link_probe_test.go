package main

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestSummarizeAgentLinkLatencies(t *testing.T) {
	median, minimum, maximum, jitter := summarizeAgentLinkLatencies([]int{10, 20, 40})
	if median != 20 || minimum != 10 || maximum != 40 || jitter != 15 {
		t.Fatalf("unexpected summary: median=%d min=%d max=%d jitter=%d", median, minimum, maximum, jitter)
	}
}

func TestValidateAgentLinkProbeTaskRejectsTransportMismatch(t *testing.T) {
	now := time.Now()
	var nonce [16]byte
	request := buildAgentProbeRequest([]byte("target-token"), agentProbeTransportTCP, now.Add(time.Minute), nonce)
	task := agentLinkProbeTask{
		TaskID:        "task-1",
		EdgeKey:       "edge-1",
		ProbeRoundID:  "round-1",
		ProbeVersion:  agentProbeProtocolVersion,
		SourceHostID:  1,
		TargetHostID:  2,
		TargetAddress: "198.51.100.2",
		TargetPort:    defaultAgentProbePort,
		Transport:     "udp",
		TimeoutMS:     1500,
		CreatedAt:     now.UnixMilli(),
		ExpiresAt:     now.Add(time.Minute).UnixMilli(),
		Attempts: []agentLinkProbeAttempt{{
			Request:          base64.StdEncoding.EncodeToString(request),
			ExpectedResponse: base64.StdEncoding.EncodeToString(expectedAgentProbeResponse([]byte("target-token"), agentProbeTransportTCP, nonce)),
		}},
	}
	_, err := validateAgentLinkProbeTaskAt(task, now)
	if err == nil || !strings.Contains(err.Error(), "transport mismatch") {
		t.Fatalf("expected transport mismatch, got %v", err)
	}
}

func TestAgentLinkProbeResultAcceptedRequiresExplicitTrue(t *testing.T) {
	if !agentLinkProbeResultAccepted(map[string]any{"success": true}) {
		t.Fatal("explicit successful response was rejected")
	}
	for _, response := range []map[string]any{{}, {"success": false}, {"success": "true"}} {
		if agentLinkProbeResultAccepted(response) {
			t.Fatalf("non-success response was accepted: %#v", response)
		}
	}
}
