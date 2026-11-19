package main

import "testing"

func TestTopologySegmentsSurviveSchedulerSnapshot(t *testing.T) {
	resetHeartbeatStateForTest()
	t.Cleanup(resetHeartbeatStateForTest)
	probe := topologySegmentProbe{RuleID: 7, SegmentKey: "topology-v1:1:127.0.0.1:443:tcp", TargetIP: "127.0.0.1", TargetPort: 443, Method: "tcp"}
	state := applyHeartbeatState(heartbeatResp{TopologySegmentProbes: []topologySegmentProbe{probe}})
	if len(state.TopologySegmentProbes) != 1 {
		t.Fatal("applyHeartbeatState lost topology segments")
	}
	state.TopologySegmentProbes[0].RuleID = 999
	applyHeartbeatState(heartbeatResp{}) // abbreviated heartbeat must preserve cache
	snapshot := heartbeatStateSnapshotCopy()
	if len(snapshot.TopologySegmentProbes) != 1 || snapshot.TopologySegmentProbes[0].RuleID != 7 {
		t.Fatalf("scheduler snapshot lost or aliased topology segments: %+v", snapshot.TopologySegmentProbes)
	}
	snapshot.TopologySegmentProbes[0].RuleID = 888
	if heartbeatStateSnapshotCopy().TopologySegmentProbes[0].RuleID != 7 {
		t.Fatal("scheduler snapshot aliases cached segments")
	}
	applyHeartbeatState(heartbeatResp{TopologySegmentProbes: []topologySegmentProbe{}})
	if len(heartbeatStateSnapshotCopy().TopologySegmentProbes) != 0 {
		t.Fatal("explicit empty segment list did not clear cache")
	}
}
