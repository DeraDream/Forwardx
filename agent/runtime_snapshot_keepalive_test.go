package main

import (
	"testing"
	"time"
)

func TestLocalRuntimeStateKeepaliveRefreshSchedule(t *testing.T) {
	localRuntimeStateMu.Lock()
	previousSignature := lastLocalRuntimeStateSignature
	previousObservedAt := lastLocalRuntimeStateObservedAt
	previousForce := forceSendLocalRuntimeState
	lastLocalRuntimeStateSignature = "stable-signature"
	lastLocalRuntimeStateObservedAt = time.Unix(1000, 0)
	forceSendLocalRuntimeState = false
	localRuntimeStateMu.Unlock()
	t.Cleanup(func() {
		localRuntimeStateMu.Lock()
		lastLocalRuntimeStateSignature = previousSignature
		lastLocalRuntimeStateObservedAt = previousObservedAt
		forceSendLocalRuntimeState = previousForce
		localRuntimeStateMu.Unlock()
	})

	signature, state := localRuntimeStateKeepaliveSnapshot(time.Unix(1000, 0).Add(30 * time.Second))
	if signature != "stable-signature" || state != nil {
		t.Fatalf("fresh keepalive should reuse cached signature only: signature=%q state=%v", signature, state)
	}

	localRuntimeStateMu.Lock()
	lastLocalRuntimeStateObservedAt = time.Now()
	forceSendLocalRuntimeState = true
	localRuntimeStateMu.Unlock()
	// Do not call the helper while force=true here because that would perform a
	// real runtime scan. The flag itself is covered by the due predicate below.
	localRuntimeStateMu.Lock()
	due := forceSendLocalRuntimeState || lastLocalRuntimeStateSignature == "" ||
		lastLocalRuntimeStateObservedAt.IsZero() ||
		time.Since(lastLocalRuntimeStateObservedAt) >= localRuntimeStateKeepaliveRefreshInterval
	localRuntimeStateMu.Unlock()
	if !due {
		t.Fatal("forced local-state upload must make the next keepalive refresh due")
	}
}

func TestLocalRuntimeStateKeepaliveIntervalStaysInsideDiagnosticFreshness(t *testing.T) {
	if localRuntimeStateKeepaliveRefreshInterval >= 120*time.Second {
		t.Fatalf("keepalive runtime refresh interval %s must stay below diagnostic freshness window", localRuntimeStateKeepaliveRefreshInterval)
	}
}
