package main

import (
	"strings"
	"testing"
	"time"
)

func validLinkSpeedTask(now time.Time) linkSpeedTask {
	return linkSpeedTask{
		TaskID:        "11111111-1111-1111-1111-111111111111",
		JobID:         "22222222-2222-2222-2222-222222222222",
		Op:            "prepare",
		Token:         strings.Repeat("a", 64),
		Protocol:      "tcp",
		Duration:      10,
		ExpiresAt:     now.Add(150 * time.Second).UnixMilli(),
		EntryAddress:  "127.0.0.1",
		EntryPort:     12345,
		SSMethod:      "aes-256-gcm",
		SSPassword:    "test-password",
		BenchmarkHost: "panel.example.test",
		BenchmarkPort: 5202,
	}
}

func TestValidateLinkSpeedTaskUsesCalibratedPanelTime(t *testing.T) {
	panelNow := time.Unix(1_800_000_000, 0)
	task := validLinkSpeedTask(panelNow)

	// The Agent host clock may be several minutes behind the panel. Validation
	// must use the authenticated panel clock, otherwise a valid lease appears to
	// be implausibly far in the future.
	agentLocalNow := panelNow.Add(-5 * time.Minute)
	if err := validateLinkSpeedTaskAt(task, agentLocalNow); err == nil || !strings.Contains(err.Error(), "future") {
		t.Fatalf("expected the uncalibrated Agent clock to reject the lease, got %v", err)
	}
	if err := validateLinkSpeedTaskAt(task, panelNow); err != nil {
		t.Fatalf("calibrated panel time rejected a valid lease: %v", err)
	}
}

func TestValidateLinkSpeedTaskRejectsExpiredLease(t *testing.T) {
	panelNow := time.Unix(1_800_000_000, 0)
	task := validLinkSpeedTask(panelNow)
	task.ExpiresAt = panelNow.Add(-time.Second).UnixMilli()
	if err := validateLinkSpeedTaskAt(task, panelNow); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expected expired lease rejection, got %v", err)
	}
}
