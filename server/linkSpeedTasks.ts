import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { pushAgentRefresh } from "./agentEvents";
import { APP_VERSION } from "../shared/versions";
import {
  linkSpeedActive,
  type LinkSpeedMeasurement,
  type LinkSpeedSample,
  type LinkSpeedStatus,
} from "../shared/linkSpeed";

export type LinkSpeedAgentTask = {
  taskId: string;
  jobId: string;
  op: "prepare" | "run" | "stop";
  token: string;
  protocol: "tcp" | "udp";
  duration: number;
  rateMbps: number;
  expiresAt: number;
  entryAddress: string;
  entryPort: number;
  ssMethod: string;
  ssPassword: string;
  benchmarkHost: string;
  benchmarkPort: number;
};

type Job = {
  userId: number;
  status: LinkSpeedStatus;
  hostId: number;
  token: string;
  taskConfig: Omit<LinkSpeedAgentTask, "taskId" | "jobId" | "op" | "expiresAt">;
  pending: Map<string, LinkSpeedAgentTask["op"]>;
  timer?: NodeJS.Timeout;
  cleanupUntil?: number;
};

const jobs = new Map<string, Job>();
const queues = new Map<number, LinkSpeedAgentTask[]>();

function enqueue(job: Job, op: LinkSpeedAgentTask["op"]) {
  const task: LinkSpeedAgentTask = {
    taskId: crypto.randomUUID(),
    jobId: job.status.id,
    op,
    expiresAt: Date.now() + 150_000,
    ...job.taskConfig,
  };
  job.pending.set(task.taskId, op);
  queues.set(job.hostId, [
    ...(queues.get(job.hostId) || []).filter((item) => item.jobId !== job.status.id || item.op === op),
    task,
  ]);
  pushAgentRefresh(job.hostId, `full-link-speed-${op}`, { urgent: true });
}

function finish(job: Job, state: "completed" | "cancelled" | "error", error?: string) {
  if (!linkSpeedActive(job.status.state)) return;
  job.status.state = state;
  job.status.error = error;
  job.status.finishedAt = new Date().toISOString();
  job.cleanupUntil = Date.now() + 155_000;
  if (job.timer) clearTimeout(job.timer);
  queues.set(job.hostId, (queues.get(job.hostId) || []).filter((item) => item.jobId !== job.status.id));
  enqueue(job, "stop");
}

export function createLinkSpeedJob(input: {
  userId: number;
  ruleId: number;
  entryHostId: number;
  pathId: string;
  name: string;
  protocol: "tcp" | "udp";
  duration: number;
  rateMbps: number;
  route: LinkSpeedStatus["route"];
  entryAddress: string;
  entryPort: number;
  ssMethod: string;
  ssPassword: string;
  benchmarkHost: string;
  benchmarkPort: number;
}) {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const finishedAt = Date.parse(job.status.finishedAt || job.status.createdAt);
    if (!linkSpeedActive(job.status.state) && now - finishedAt > 60 * 60_000) jobs.delete(id);
  }
  for (const job of jobs.values()) {
    if (job.hostId === input.entryHostId && (linkSpeedActive(job.status.state) || Number(job.cleanupUntil) > now)) {
      throw new Error("该入口主机正在执行全链路测速，请等待当前任务结束");
    }
  }
  const token = crypto.randomBytes(32).toString("hex");
  const status: LinkSpeedStatus = {
    id: crypto.randomUUID(),
    ruleId: input.ruleId,
    entryHostId: input.entryHostId,
    pathId: input.pathId,
    name: input.name,
    protocol: input.protocol,
    duration: input.duration,
    rateMbps: input.rateMbps,
    state: "preparing",
    route: input.route,
    samples: [],
    createdAt: new Date().toISOString(),
    benchmark: {
      formatVersion: 1,
      panelVersion: APP_VERSION,
      generatedAt: new Date().toISOString(),
      durationSeconds: input.duration,
      offeredRateMbps: input.rateMbps,
      routeHostIds: input.route.map((node) => node.hostId),
      agentVersions: Object.fromEntries(input.route.map((node) => [String(node.hostId), String(node.agentVersion || "unknown")])),
      methodology: "入口 Agent 使用当前规则入口和最终落地 SS 参数，经过正式转发路径访问面板测速接收器；测速流量按普通业务流量统计。",
    },
  };
  const job: Job = {
    userId: input.userId,
    status,
    hostId: input.entryHostId,
    token,
    pending: new Map(),
    taskConfig: {
      token,
      protocol: input.protocol,
      duration: input.duration,
      rateMbps: input.rateMbps,
      entryAddress: input.entryAddress,
      entryPort: input.entryPort,
      ssMethod: input.ssMethod,
      ssPassword: input.ssPassword,
      benchmarkHost: input.benchmarkHost,
      benchmarkPort: input.benchmarkPort,
    },
  };
  jobs.set(status.id, job);
  job.timer = setTimeout(() => finish(job, "error", "测速超时，请检查入口规则、落地 SS 和测速端口的 TCP/UDP 连通性"), 140_000);
  job.timer.unref?.();
  enqueue(job, "prepare");
  return status;
}

export function hasQueuedLinkSpeedTasks(hostId: number) {
  return (queues.get(Number(hostId))?.length || 0) > 0;
}

export function takeLinkSpeedTasks(hostId: number) {
  const tasks = queues.get(Number(hostId)) || [];
  queues.delete(Number(hostId));
  return tasks.filter((task) => {
    const job = jobs.get(task.jobId);
    return task.expiresAt > Date.now() && !!job && (task.op === "stop" || linkSpeedActive(job.status.state));
  });
}

export function claimLinkSpeedTask(hostId: number, taskId: string, jobId: string) {
  const job = jobs.get(jobId);
  return !!job && job.hostId === Number(hostId) && job.pending.has(taskId)
    && (job.pending.get(taskId) === "stop" || linkSpeedActive(job.status.state));
}

function measurement(value: any): LinkSpeedMeasurement | undefined {
  if (!value || !Number.isFinite(value.bytes) || value.bytes < 0 || !Number.isFinite(value.durationMs) || value.durationMs <= 0) return undefined;
  const result: LinkSpeedMeasurement = {
    bytes: Number(value.bytes),
    durationMs: Number(value.durationMs),
    mbps: Number.isFinite(value.mbps) ? Math.max(0, Number(value.mbps)) : Number(value.bytes) * 8 / Number(value.durationMs) / 1000,
    peakMbps: Number.isFinite(value.peakMbps) ? Math.max(0, Number(value.peakMbps)) : 0,
  };
  for (const key of ["packets", "sentPackets", "lostPackets", "lossPercent", "jitterMs"] as const) {
    if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = Number(value[key]);
  }
  return result;
}

export function reportLinkSpeedTask(hostId: number, report: any) {
  if (!report || typeof report.jobId !== "string" || typeof report.taskId !== "string") return false;
  const job = jobs.get(report.jobId);
  const op = job?.pending.get(report.taskId);
  if (!job || job.hostId !== Number(hostId) || !op) return false;
  if (op === "stop") {
    if (report.state === "stopped") {
      job.pending.delete(report.taskId);
      job.cleanupUntil = 0;
    }
    return true;
  }
  if (!linkSpeedActive(job.status.state)) return false;
  if (report.state === "error") {
    finish(job, "error", String(report.error || "Agent 全链路测速失败").slice(0, 1000));
    return true;
  }
  if (op === "prepare") {
    if (report.state !== "ready") return false;
    job.pending.delete(report.taskId);
    job.status.state = "upload";
    enqueue(job, "run");
    return true;
  }
  const samples = Array.isArray(report.samples) ? report.samples.slice(0, 64) : report.sample ? [report.sample] : [];
  for (const sample of samples as LinkSpeedSample[]) {
    if (!sample || (sample.direction !== "upload" && sample.direction !== "download")) continue;
    const last = job.status.samples.at(-1);
    if ([sample.elapsedMs, sample.bytes, sample.mbps].every((value) => Number.isFinite(value) && value >= 0)
      && sample.elapsedMs <= (job.status.duration + 5) * 1000
      && job.status.samples.length < 800
      && !(last?.direction === "download" && sample.direction === "upload")
      && (last?.direction !== sample.direction || (sample.elapsedMs > last.elapsedMs && sample.bytes >= last.bytes))) {
      job.status.state = sample.direction;
      job.status.samples.push({
        direction: sample.direction,
        elapsedMs: Number(sample.elapsedMs),
        bytes: Number(sample.bytes),
        mbps: Number(sample.mbps),
      });
    }
  }
  if (report.upload) job.status.upload = measurement(report.upload);
  if (report.download) job.status.download = measurement(report.download);
  if (report.state === "completed") {
    if (!job.status.upload || !job.status.download) {
      finish(job, "error", "Agent 未返回完整的上传和下载测速结果");
    } else {
      finish(job, "completed");
    }
  }
  return true;
}

export function getLinkSpeedJob(id: string, user: { id: number; role: string }) {
  const job = jobs.get(id);
  if (!job || (user.role !== "admin" && job.userId !== user.id)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "测速任务不存在或无权访问" });
  }
  return job;
}

export function latestLinkSpeedJob(pathId: string, userId: number) {
  return [...jobs.values()].reverse().find((job) => job.userId === userId && job.status.pathId === pathId)?.status || null;
}

export function cancelLinkSpeedJob(id: string, user: { id: number; role: string }) {
  const job = getLinkSpeedJob(id, user);
  finish(job, "cancelled");
  return job.status;
}

export function getLinkSpeedBenchmarkLease(token: string) {
  const job = [...jobs.values()].find((candidate) => candidate.token === token);
  if (!job || !linkSpeedActive(job.status.state)) return null;
  return { duration: job.status.duration, rateMbps: job.status.rateMbps, protocol: job.status.protocol };
}
