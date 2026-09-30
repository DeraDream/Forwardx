import type { Router, Request, Response } from "express";
import { getAgentHostFromRequest } from "./agentAuth";
import { reportHostNetworkProfile } from "./hostNetworkProfileState";

function familyOf(value: unknown): "ipv4" | "ipv6" | null {
  const text = String(value || "").trim().toLowerCase();
  return text === "ipv4" || text === "ipv6" ? text : null;
}

export function registerAgentNetworkProfileRoutes(router: Router) {
  router.post("/api/agent/network-profile-report", async (req: Request, res: Response) => {
    try {
      const host = await getAgentHostFromRequest(req);
      if (!host) {
        res.status(401).json({ error: "Invalid token" });
        return;
      }
      const family = familyOf(req.body?.family);
      const taskId = String(req.body?.taskId || "").trim().slice(0, 160);
      const stage = String(req.body?.stage || "").trim().slice(0, 80);
      const status = String(req.body?.status || "").trim();
      const allowed = new Set(["pending", "running", "success", "error", "skip"]);
      if (!family || !taskId || !stage || !allowed.has(status)) {
        res.status(400).json({ error: "Invalid network profile report" });
        return;
      }
      const accepted = await reportHostNetworkProfile({
        hostId: Number(host.id),
        taskId,
        family,
        stage,
        status: status as any,
        data: req.body?.data,
        message: typeof req.body?.message === "string" ? req.body.message.slice(0, 2000) : null,
        completed: req.body?.completed === true,
        failed: req.body?.failed === true,
      });
      res.json({ success: true, accepted });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
