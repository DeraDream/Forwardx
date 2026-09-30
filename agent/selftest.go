package main

import (
	"context"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const selfTestWorkerConcurrency = 16
const selfTestQueueCapacity = 256
const selfTestRuntimeReadinessWindow = 20 * time.Second
const selfTestActionWaitWindow = 4 * time.Second
const selfTestPostActionReadinessWindow = 5 * time.Second
const selfTestTCPAttemptTimeout = 1500 * time.Millisecond
const selfTestWireGuardAttemptTimeout = 2500 * time.Millisecond
const selfTestPingTimeout = 1500 * time.Millisecond
const selfTestRetryBaseDelay = 250 * time.Millisecond
const selfTestRetryMaxDelay = 750 * time.Millisecond

type selfTestJob struct {
	cfg  Config
	test selfTest
}

var selfTestQueue = make(chan selfTestJob, selfTestQueueCapacity)
var selfTestWorkersOnce sync.Once
var selfTestInFlightMu sync.Mutex
var selfTestInFlight = map[int]bool{}

func pullSelfTestsOnce(cfg Config) {
	var resp selfTestResp
	if err := post(cfg, "/api/agent/selftest-pull", map[string]any{}, &resp); err != nil {
		logAgentCommError("selftest-pull", err)
		return
	}
	for _, t := range resp.SelfTests {
		enqueueSelfTest(cfg, t)
	}
}

func selfTestPoller(cfg Config) {
	activeUntil := time.Time{}
	for {
		if !shouldPollSelfTests(agentEventStreamConnected.Load()) {
			time.Sleep(selfTestIdlePollInterval)
			continue
		}
		var resp selfTestResp
		if err := post(cfg, "/api/agent/selftest-pull", map[string]any{}, &resp); err != nil {
			logAgentCommError("selftest-pull", err)
		} else {
			if len(resp.SelfTests) > 0 {
				activeUntil = time.Now().Add(selfTestActiveWindow)
			}
			for _, t := range resp.SelfTests {
				enqueueSelfTest(cfg, t)
			}
		}
		interval := selfTestIdlePollInterval
		if time.Now().Before(activeUntil) {
			interval = selfTestActivePollInterval
		}
		time.Sleep(interval)
	}
}

func shouldPollSelfTests(eventStreamConnected bool) bool {
	return !eventStreamConnected
}

func enqueueSelfTest(cfg Config, t selfTest) {
	if !claimSelfTest(t.TestID) {
		return
	}
	selfTestWorkersOnce.Do(startSelfTestWorkers)
	select {
	case selfTestQueue <- selfTestJob{cfg: cfg, test: t}:
	default:
		releaseSelfTest(t.TestID)
		if shouldLogAgentReport("selftest-queue-full", agentReportLogInterval) {
			logf("selftest queue full; dropping test=%d target=%s", t.TestID, t.TargetIP)
		}
	}
}

func enqueueSelfTestsAfterActions(cfg Config, tests []selfTest, actionDone []<-chan struct{}) {
	if len(tests) == 0 {
		return
	}
	tests = append([]selfTest(nil), tests...)
	actionDone = append([]<-chan struct{}(nil), actionDone...)
	enqueue := func() {
		actionsCompleted := len(actionDone) == 0
		if len(actionDone) > 0 {
			actionsCompleted = waitForActionBatch(actionDone, selfTestActionWaitWindow)
		}
		for _, test := range tests {
			test.runtimeActionsWaited = len(actionDone) > 0 && actionsCompleted
			enqueueSelfTest(cfg, test)
		}
	}
	if len(actionDone) == 0 {
		enqueue()
		return
	}
	go enqueue()
}

func startSelfTestWorkers() {
	for i := 0; i < selfTestWorkerConcurrency; i++ {
		go func() {
			for job := range selfTestQueue {
				func() {
					defer releaseSelfTest(job.test.TestID)
					handleSelfTest(job.cfg, job.test)
				}()
			}
		}()
	}
}

func claimSelfTest(testID int) bool {
	if testID <= 0 {
		return false
	}
	selfTestInFlightMu.Lock()
	defer selfTestInFlightMu.Unlock()
	if selfTestInFlight[testID] {
		return false
	}
	selfTestInFlight[testID] = true
	return true
}

func releaseSelfTest(testID int) {
	selfTestInFlightMu.Lock()
	delete(selfTestInFlight, testID)
	selfTestInFlightMu.Unlock()
}

func diagnosticDNSLookup(target string) (int, []string, string, bool) {
	host := strings.Trim(strings.TrimSpace(target), "[]")
	if host == "" {
		return 0, nil, "目标为空", false
	}
	if ip := net.ParseIP(host); ip != nil {
		return 0, []string{ip.String()}, "", true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	started := time.Now()
	addrs, err := net.DefaultResolver.LookupHost(ctx, host)
	elapsed := int(time.Since(started).Milliseconds())
	if err != nil {
		return elapsed, nil, err.Error(), false
	}
	seen := map[string]bool{}
	clean := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		addr = strings.TrimSpace(addr)
		if addr == "" || seen[addr] {
			continue
		}
		seen[addr] = true
		clean = append(clean, addr)
		if len(clean) >= 8 {
			break
		}
	}
	if len(clean) == 0 {
		return elapsed, nil, "未返回地址", false
	}
	return elapsed, clean, "", false
}

func diagnosticJitter(samples []int) int {
	if len(samples) < 2 {
		return 0
	}
	total := 0
	for i := 1; i < len(samples); i++ {
		delta := samples[i] - samples[i-1]
		if delta < 0 {
			delta = -delta
		}
		total += delta
	}
	return total / (len(samples) - 1)
}

func diagnosticAverage(samples []int) int {
	if len(samples) == 0 {
		return 0
	}
	total := 0
	for _, sample := range samples {
		total += sample
	}
	return total / len(samples)
}

func diagnosticPortInspection(t selfTest) map[string]any {
	result := map[string]any{
		"sourcePort":      t.SourcePort,
		"sourceProtocol":  strings.TrimSpace(t.SourceProtocol),
		"expectedRuleId":  t.ExpectedRuleID,
		"expectedForwardType": strings.TrimSpace(t.ExpectedForwardType),
	}
	if t.SourcePort <= 0 {
		result["available"] = false
		return result
	}

	state := readLocalRuntimeStatePayload()
	matches := make([]localRuntimeRuleState, 0)
	var exact *localRuntimeRuleState
	for i := range state.Rules {
		item := state.Rules[i]
		if item.Port != t.SourcePort {
			continue
		}
		matches = append(matches, item)
		if t.ExpectedRuleID > 0 && item.RuleID == t.ExpectedRuleID {
			copy := item
			exact = &copy
		}
	}
	if exact == nil && t.ExpectedRuleID <= 0 && len(matches) == 1 {
		copy := matches[0]
		exact = &copy
	}

	result["available"] = true
	result["managedRuleCount"] = len(matches)
	result["runtimeReady"] = exact != nil && exact.Ready
	if exact != nil {
		result["actualRuleId"] = exact.RuleID
		result["actualForwardType"] = exact.ForwardType
		result["actualProtocol"] = exact.Protocol
	}

	conflictingRuleIDs := make([]int, 0)
	for _, item := range matches {
		if t.ExpectedRuleID > 0 && item.RuleID == t.ExpectedRuleID {
			continue
		}
		if item.RuleID > 0 {
			conflictingRuleIDs = append(conflictingRuleIDs, item.RuleID)
		}
	}
	if len(conflictingRuleIDs) > 0 {
		result["conflictingRuleIds"] = conflictingRuleIDs
	}

	snapshot := newRuntimeListenSnapshot()
	protocols := runtimeProtocols(t.SourceProtocol)
	ownerLines := make([]string, 0)
	socketPresent := false
	for _, proto := range protocols {
		var lines []string
		if normalizeRuntimeProtocol(proto) == "udp" {
			lines = snapshot.udpPorts[t.SourcePort]
		} else {
			lines = snapshot.tcpPorts[t.SourcePort]
		}
		if len(lines) > 0 {
			socketPresent = true
		}
		for _, line := range lines {
			if len(ownerLines) >= 6 {
				break
			}
			if len(line) > 320 {
				line = line[:320]
			}
			ownerLines = append(ownerLines, line)
		}
	}
	result["socketPresent"] = socketPresent
	if len(ownerLines) > 0 {
		result["listenerOwners"] = ownerLines
	}

	forwardType := strings.ToLower(strings.TrimSpace(t.ExpectedForwardType))
	processBackend := forwardType == "gost" || forwardType == "realm" || forwardType == "socat" ||
		forwardType == "nginx" || forwardType == "forwardx" ||
		strings.Contains(forwardType, "tunnel")
	portConflict := len(conflictingRuleIDs) > 0
	if processBackend && exact == nil && socketPresent {
		portConflict = true
	}
	result["portConflict"] = portConflict
	return result
}

func handleSelfTest(cfg Config, t selfTest) {
	diagnostic := strings.EqualFold(strings.TrimSpace(t.Kind), "diagnostic-hop")
	dnsMs, dnsAddresses, dnsError, dnsSkipped := 0, []string(nil), "", false
	var portInspection map[string]any
	if diagnostic {
		dnsMs, dnsAddresses, dnsError, dnsSkipped = diagnosticDNSLookup(t.TargetIP)
		portInspection = diagnosticPortInspection(t)
	}

	method := strings.ToLower(strings.TrimSpace(t.Method))
	if method == "" {
		method = strings.ToLower(strings.TrimSpace(t.Protocol))
	}
	if normalizeRuntimeProtocol(method) == "udp" {
		method = "ping"
	}
	if method == "ping" {
		latency, reachable, detail := pingLatency(t.TargetIP, selfTestPingTimeout)
		msg := ""
		if reachable {
			msg = fmt.Sprintf("目标 %s Ping可达，延迟 %dms", t.TargetIP, latency)
		} else {
			msg = fmt.Sprintf("目标 %s Ping不可达：%s", t.TargetIP, detail)
		}
		payload := map[string]any{
			"testId":          t.TestID,
			"targetReachable": reachable,
			"latencyMs":       latency,
			"message":         msg,
		}
		if diagnostic {
			payload["dnsMs"] = dnsMs
			payload["dnsAddresses"] = dnsAddresses
			payload["dnsError"] = dnsError
			payload["dnsSkipped"] = dnsSkipped
			payload["portInspection"] = portInspection
			payload["latencySamples"] = []int{latency}
			payload["sampleAttempts"] = 1
			if reachable {
				payload["sampleSuccesses"] = 1
			} else {
				payload["sampleSuccesses"] = 0
			}
			payload["isFinalTarget"] = t.IsFinalTarget
		}
		if err := post(cfg, "/api/agent/selftest-result", payload, &map[string]any{}); err != nil {
			logSelfTestReportError(t.TestID, t.TargetIP, err)
		}
		return
	}

	latency, reachable, resolvedTarget := 0, false, ""
	latencySamples := []int{}
	sampleAttempts := 0
	minimumAttempts := selfTestTCPAttempts(t)
	readinessWindow := selfTestTCPReadinessWindow(t)
	startedAt := time.Now()
	for attempt := 0; ; attempt++ {
		if attempt > 0 {
			delay := selfTestRetryDelay(attempt)
			if readinessWindow > 0 {
				remaining := readinessWindow - time.Since(startedAt)
				if remaining <= 0 {
					break
				}
				if delay > remaining {
					delay = remaining
				}
			}
			time.Sleep(delay)
		}
		attemptTimeout := selfTestTCPAttemptTimeout
		if t.WireGuardPeerID != "" && t.TunnelID > 0 {
			attemptTimeout = selfTestWireGuardAttemptTimeout
		}
		if readinessWindow > 0 {
			remaining := readinessWindow - time.Since(startedAt)
			if remaining <= 0 {
				break
			}
			if attemptTimeout > remaining {
				attemptTimeout = remaining
			}
		}
		if t.WireGuardPeerID != "" && t.TunnelID > 0 {
			latency, reachable = wireGuardTCPLatency(t.TunnelID, t.WireGuardPeerID, t.TargetPort, attemptTimeout)
		} else {
			latency, reachable, resolvedTarget = tcpLatencyResolved(t.TargetIP, t.TargetPort, attemptTimeout)
		}
		if reachable {
			latencies := []int{latency}
			sampleAttempts = 1
			sampleCount := selfTestTCPSampleCount(t)
			for attempts := 1; attempts < sampleCount; attempts++ {
				time.Sleep(180 * time.Millisecond)
				sampleAttempts++
				sample, ok, _ := tcpLatencyResolved(t.TargetIP, t.TargetPort, selfTestTCPAttemptTimeout)
				if ok {
					latencies = append(latencies, sample)
				}
			}
			latencySamples = append(latencySamples, latencies...)
			latency = medianLatency(append([]int(nil), latencies...))
			break
		}
		if attempt+1 >= minimumAttempts && (readinessWindow <= 0 || time.Since(startedAt) >= readinessWindow) {
			break
		}
	}
	target := net.JoinHostPort(t.TargetIP, strconv.Itoa(t.TargetPort))
	msg := ""
	if reachable {
		msg = fmt.Sprintf("目标 %s TCP可达，延迟 %dms", target, latency)
		if resolvedTarget != "" && resolvedTarget != normalizeNetworkTargetHost(t.TargetIP) {
			msg = fmt.Sprintf("%s，解析到 %s", msg, resolvedTarget)
		}
	} else {
		latency = 0
		msg = fmt.Sprintf("目标 %s TCP不可达或超时", target)
	}
	payload := map[string]any{
		"testId":          t.TestID,
		"targetReachable": reachable,
		"latencyMs":       latency,
		"message":         msg,
	}
	if diagnostic {
		if sampleAttempts == 0 {
			sampleAttempts = selfTestTCPAttempts(t)
		}
		payload["latencySamples"] = latencySamples
		payload["sampleAttempts"] = sampleAttempts
		payload["sampleSuccesses"] = len(latencySamples)
		payload["jitterMs"] = diagnosticJitter(latencySamples)
		payload["averageLatencyMs"] = diagnosticAverage(latencySamples)
		if len(latencySamples) > 0 {
			sorted := append([]int(nil), latencySamples...)
			sort.Ints(sorted)
			payload["minLatencyMs"] = sorted[0]
			payload["maxLatencyMs"] = sorted[len(sorted)-1]
		}
		payload["dnsMs"] = dnsMs
		payload["dnsAddresses"] = dnsAddresses
		payload["dnsError"] = dnsError
		payload["dnsSkipped"] = dnsSkipped
		payload["portInspection"] = portInspection
		payload["isFinalTarget"] = t.IsFinalTarget
	}
	if resolvedTarget != "" {
		payload["resolvedTargetIp"] = resolvedTarget
	}
	if err := post(cfg, "/api/agent/selftest-result", payload, &map[string]any{}); err != nil {
		logSelfTestReportError(t.TestID, target, err)
	}
}

func selfTestTCPAttempts(t selfTest) int {
	switch strings.ToLower(strings.TrimSpace(t.Kind)) {
	case "diagnostic-hop", "tunnel", "tunnel-hop", "forward-via-tunnel", "forward-via-tunnel-entry", "forward-chain", "full-chain":
		return 4
	default:
		return 1
	}
}

func selfTestTCPSampleCount(t selfTest) int {
	if strings.EqualFold(strings.TrimSpace(t.Kind), "diagnostic-hop") {
		count := t.SampleCount
		if count <= 0 {
			count = 5
		}
		if count > 8 {
			count = 8
		}
		return count
	}
	if strings.EqualFold(strings.TrimSpace(t.Kind), "full-chain") {
		return 3
	}
	return 1
}

func medianLatency(latencies []int) int {
	sort.Ints(latencies)
	return latencies[len(latencies)/2]
}

func selfTestDependsOnRuntime(t selfTest) bool {
	if strings.TrimSpace(t.WireGuardPeerID) != "" {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(t.Kind)) {
	case "tunnel", "tunnel-hop", "forward-via-tunnel", "forward-via-tunnel-entry", "forward-chain", "full-chain":
		return true
	default:
		return false
	}
}

func selfTestTCPReadinessWindow(t selfTest) time.Duration {
	if selfTestDependsOnRuntime(t) {
		if t.runtimeActionsWaited {
			return selfTestPostActionReadinessWindow
		}
		return selfTestRuntimeReadinessWindow
	}
	return 0
}

func selfTestRetryDelay(attempt int) time.Duration {
	if attempt < 1 {
		return 0
	}
	delay := time.Duration(attempt) * selfTestRetryBaseDelay
	if delay > selfTestRetryMaxDelay {
		return selfTestRetryMaxDelay
	}
	return delay
}

func logSelfTestReportError(testID int, target string, err error) {
	if isTransientAgentCommError(err) {
		logAgentCommError("selftest-result", err)
		return
	}
	if shouldLogAgentReport("selftest-report-failed", agentReportLogInterval) {
		logf("selftest report failed test=%d target=%s: %v", testID, target, err)
	}
}
