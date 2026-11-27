//go:build iptablesonly

package main

// The kernel-forwarding-only build cannot execute speed-test tasks. Retain
// just the envelope needed to reject tasks from older panel installations.
type linkSpeedTask struct {
	TaskID string `json:"taskId"`
	JobID  string `json:"jobId"`
	Op     string `json:"op"`
}

func cleanupStaleLinkSpeedNetworkNamespaces() {}

func handleLinkSpeedTask(cfg Config, task linkSpeedTask) {
	if task.TaskID == "" || task.JobID == "" {
		return
	}
	result := map[string]any{"taskId": task.TaskID, "jobId": task.JobID, "state": "error", "error": "轻量 Agent 不支持全链路测速"}
	if task.Op == "stop" {
		result["state"] = "stopped"
		delete(result, "error")
	}
	if err := post(cfg, "/api/agent/link-speed-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		logf("iptables-only Agent speed task rejection report failed: %v", err)
	}
}
