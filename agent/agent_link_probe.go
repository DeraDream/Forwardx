package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"
)

const agentLinkProbeMaxConcurrency = 16

var agentLinkProbeSlots = make(chan struct{}, agentLinkProbeMaxConcurrency)

type agentLinkProbeAttempt struct {
	Request          string `json:"request"`
	ExpectedResponse string `json:"expectedResponse"`
}

type agentLinkProbeTask struct {
	TaskID        string                  `json:"taskId"`
	EdgeKey       string                  `json:"edgeKey"`
	ProbeRoundID  string                  `json:"probeRoundId"`
	ProbeVersion  int                     `json:"probeVersion"`
	SourceHostID  int                     `json:"sourceHostId"`
	TargetHostID  int                     `json:"targetHostId"`
	TargetAddress string                  `json:"targetAddress"`
	TargetPort    int                     `json:"targetPort"`
	Transport     string                  `json:"transport"`
	TimeoutMS     int                     `json:"timeoutMs"`
	Attempts      []agentLinkProbeAttempt `json:"attempts"`
	CreatedAt     int64                   `json:"createdAt"`
	ExpiresAt     int64                   `json:"expiresAt"`
}

type agentLinkProbeTaskResult struct {
	TaskID         string `json:"taskId"`
	ProbeRoundID   string `json:"probeRoundId"`
	LatencyMS      *int   `json:"latencyMs"`
	MinLatencyMS   *int   `json:"minLatencyMs"`
	MaxLatencyMS   *int   `json:"maxLatencyMs"`
	JitterMS       *int   `json:"jitterMs"`
	ProbeCount     int    `json:"probeCount"`
	ProbeSuccesses int    `json:"probeSuccesses"`
	ErrorCode      string `json:"errorCode,omitempty"`
	ErrorMessage   string `json:"errorMessage,omitempty"`
	RecordedAt     string `json:"recordedAt"`
}

type decodedAgentLinkProbeAttempt struct {
	request          []byte
	expectedResponse []byte
}

func validateAgentLinkProbeTaskAt(task agentLinkProbeTask, now time.Time) ([]decodedAgentLinkProbeAttempt, error) {
	if strings.TrimSpace(task.TaskID) == "" || strings.TrimSpace(task.EdgeKey) == "" || strings.TrimSpace(task.ProbeRoundID) == "" {
		return nil, errors.New("task identifiers are required")
	}
	if task.ProbeVersion != agentProbeProtocolVersion {
		return nil, fmt.Errorf("unsupported probe version %d", task.ProbeVersion)
	}
	if task.TargetHostID <= 0 || strings.TrimSpace(task.TargetAddress) == "" || task.TargetPort < 1 || task.TargetPort > 65535 {
		return nil, errors.New("invalid target endpoint")
	}
	if task.Transport != "tcp" && task.Transport != "udp" {
		return nil, errors.New("unsupported transport")
	}
	if task.TimeoutMS < 250 || task.TimeoutMS > 10_000 {
		return nil, errors.New("invalid timeout")
	}
	if len(task.Attempts) < 1 || len(task.Attempts) > 10 {
		return nil, errors.New("invalid attempt count")
	}
	if task.ExpiresAt <= now.UnixMilli() {
		return nil, errors.New("task expired")
	}
	if task.CreatedAt > now.Add(time.Minute).UnixMilli() || task.ExpiresAt > now.Add(15*time.Minute).UnixMilli() {
		return nil, errors.New("invalid task time window")
	}
	decoded := make([]decodedAgentLinkProbeAttempt, 0, len(task.Attempts))
	for _, attempt := range task.Attempts {
		request, err := base64.StdEncoding.DecodeString(strings.TrimSpace(attempt.Request))
		if err != nil || len(request) != agentProbeRequestSize {
			return nil, errors.New("invalid probe request")
		}
		expected, err := base64.StdEncoding.DecodeString(strings.TrimSpace(attempt.ExpectedResponse))
		if err != nil || len(expected) != agentProbeResponseSize {
			return nil, errors.New("invalid expected probe response")
		}
		transport := agentProbeTransportTCP
		if task.Transport == "udp" {
			transport = agentProbeTransportUDP
		}
		if request[4] != agentProbeProtocolVersion || request[5] != transport || expected[4] != agentProbeProtocolVersion || expected[5] != transport {
			return nil, errors.New("probe payload transport mismatch")
		}
		decoded = append(decoded, decodedAgentLinkProbeAttempt{request: request, expectedResponse: expected})
	}
	return decoded, nil
}

func handleAgentLinkProbeTask(cfg Config, task agentLinkProbeTask) {
	select {
	case agentLinkProbeSlots <- struct{}{}:
		defer func() { <-agentLinkProbeSlots }()
	case <-time.After(2 * time.Second):
		reportAgentLinkProbeResult(cfg, agentLinkProbeTaskResult{
			TaskID:         task.TaskID,
			ProbeRoundID:   task.ProbeRoundID,
			ProbeCount:     len(task.Attempts),
			ProbeSuccesses: 0,
			ErrorCode:      "agent-busy",
			ErrorMessage:   "Agent Link probe worker limit reached",
			RecordedAt:     time.Now().UTC().Format(time.RFC3339Nano),
		})
		return
	}
	result := runAgentLinkProbeTaskAt(task, encryptedResponseNow(currentPanelURL(cfg)))
	reportAgentLinkProbeResult(cfg, result)
}

func runAgentLinkProbeTaskAt(task agentLinkProbeTask, panelNow time.Time) agentLinkProbeTaskResult {
	result := agentLinkProbeTaskResult{
		TaskID:       task.TaskID,
		ProbeRoundID: task.ProbeRoundID,
		ProbeCount:   len(task.Attempts),
		RecordedAt:   time.Now().UTC().Format(time.RFC3339Nano),
		ErrorCode:    "probe-failed",
		ErrorMessage: "all Agent Link probe attempts failed",
	}
	attempts, err := validateAgentLinkProbeTaskAt(task, panelNow)
	if err != nil {
		result.ErrorCode = "invalid-task"
		result.ErrorMessage = err.Error()
		return result
	}
	endpoint := net.JoinHostPort(strings.Trim(strings.TrimSpace(task.TargetAddress), "[]"), strconv.Itoa(task.TargetPort))
	timeout := time.Duration(task.TimeoutMS) * time.Millisecond
	latencies := make([]int, 0, len(attempts))
	lastCode := "probe-failed"
	lastMessage := result.ErrorMessage
	for _, attempt := range attempts {
		var latency int
		if task.Transport == "udp" {
			latency, lastCode, lastMessage, err = runAgentLinkUDPAttempt(endpoint, timeout, attempt)
		} else {
			latency, lastCode, lastMessage, err = runAgentLinkTCPAttempt(endpoint, timeout, attempt)
		}
		if err == nil {
			latencies = append(latencies, latency)
		}
	}
	result.ProbeSuccesses = len(latencies)
	if len(latencies) == 0 {
		result.ErrorCode = lastCode
		result.ErrorMessage = lastMessage
		return result
	}
	median, minimum, maximum, jitter := summarizeAgentLinkLatencies(latencies)
	result.LatencyMS = intPointer(median)
	result.MinLatencyMS = intPointer(minimum)
	result.MaxLatencyMS = intPointer(maximum)
	result.JitterMS = intPointer(jitter)
	if len(latencies) < len(attempts) {
		result.ErrorCode = "partial-loss"
		result.ErrorMessage = fmt.Sprintf("%d of %d Agent Link probe attempts succeeded; last error: %s", len(latencies), len(attempts), lastMessage)
	} else {
		result.ErrorCode = ""
		result.ErrorMessage = ""
	}
	return result
}

func runAgentLinkTCPAttempt(endpoint string, timeout time.Duration, attempt decodedAgentLinkProbeAttempt) (int, string, string, error) {
	startedAt := time.Now()
	conn, err := net.DialTimeout("tcp", endpoint, timeout)
	connectedAt := time.Now()
	if err != nil {
		code := agentLinkNetworkErrorCode(err, "dial-failed")
		return 0, code, err.Error(), err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if _, err := conn.Write(attempt.request); err != nil {
		code := agentLinkNetworkErrorCode(err, "write-failed")
		return 0, code, err.Error(), err
	}
	response := make([]byte, len(attempt.expectedResponse))
	if _, err := io.ReadFull(conn, response); err != nil {
		code := agentLinkNetworkErrorCode(err, "read-failed")
		return 0, code, err.Error(), err
	}
	if !bytes.Equal(response, attempt.expectedResponse) {
		err := errors.New("Agent probe response authentication failed")
		return 0, "invalid-response", err.Error(), err
	}
	return roundedMilliseconds(connectedAt.Sub(startedAt)), "", "", nil
}

func runAgentLinkUDPAttempt(endpoint string, timeout time.Duration, attempt decodedAgentLinkProbeAttempt) (int, string, string, error) {
	conn, err := net.DialTimeout("udp", endpoint, timeout)
	if err != nil {
		code := agentLinkNetworkErrorCode(err, "dial-failed")
		return 0, code, err.Error(), err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	startedAt := time.Now()
	if _, err := conn.Write(attempt.request); err != nil {
		code := agentLinkNetworkErrorCode(err, "write-failed")
		return 0, code, err.Error(), err
	}
	response := make([]byte, len(attempt.expectedResponse))
	if _, err := io.ReadFull(conn, response); err != nil {
		code := agentLinkNetworkErrorCode(err, "read-failed")
		return 0, code, err.Error(), err
	}
	if !bytes.Equal(response, attempt.expectedResponse) {
		err := errors.New("Agent probe response authentication failed")
		return 0, "invalid-response", err.Error(), err
	}
	return roundedMilliseconds(time.Since(startedAt)), "", "", nil
}

func agentLinkNetworkErrorCode(err error, fallback string) string {
	if networkError, ok := err.(net.Error); ok && networkError.Timeout() {
		return "timeout"
	}
	return fallback
}

func roundedMilliseconds(duration time.Duration) int {
	if duration <= 0 {
		return 0
	}
	return int((duration + time.Millisecond/2) / time.Millisecond)
}

func summarizeAgentLinkLatencies(values []int) (median int, minimum int, maximum int, jitter int) {
	if len(values) == 0 {
		return 0, 0, 0, 0
	}
	ordered := append([]int(nil), values...)
	sort.Ints(ordered)
	minimum = ordered[0]
	maximum = ordered[len(ordered)-1]
	middle := len(ordered) / 2
	if len(ordered)%2 == 0 {
		median = (ordered[middle-1] + ordered[middle] + 1) / 2
	} else {
		median = ordered[middle]
	}
	if len(values) > 1 {
		total := 0
		for index := 1; index < len(values); index++ {
			delta := values[index] - values[index-1]
			if delta < 0 {
				delta = -delta
			}
			total += delta
		}
		jitter = (total + (len(values)-1)/2) / (len(values) - 1)
	}
	return median, minimum, maximum, jitter
}

func intPointer(value int) *int {
	copy := value
	return &copy
}

func agentLinkProbeResultAccepted(response map[string]any) bool {
	accepted, ok := response["success"].(bool)
	return ok && accepted
}

func reportAgentLinkProbeResult(cfg Config, result agentLinkProbeTaskResult) {
	payload := map[string]any{"token": cfg.Token, "result": result}
	delays := []time.Duration{0, time.Second, 3 * time.Second}
	for index, delay := range delays {
		if delay > 0 {
			time.Sleep(delay)
		}
		var response map[string]any
		err := post(cfg, "/api/agent/agent-link-probe-result", payload, &response)
		if err == nil && agentLinkProbeResultAccepted(response) {
			return
		}
		if err == nil {
			err = errors.New("panel did not accept Agent Link probe result")
		}
		if index == len(delays)-1 {
			logf("agent link probe result report failed task=%s round=%s successes=%d/%d error=%v", result.TaskID, result.ProbeRoundID, result.ProbeSuccesses, result.ProbeCount, err)
		}
	}
}
