export type LinkQualitySample = {
  recordedAt?: string | Date | number | null;
  latencyMs?: number | string | null;
  isTimeout?: boolean | number | null;
};

export type LinkQualityStats = {
  total: number;
  success: number;
  timeout: number;
  availability: number | null;
  timeoutRate: number | null;
  currentLatency: number | null;
  currentIsTimeout: boolean;
  average: number | null;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  jitter: number | null;
  lastRecordedAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  status: "no-data" | "healthy" | "unstable" | "degraded";
};

function sampleTime(value: LinkQualitySample["recordedAt"]) {
  if (value == null || value === "") return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value < 1_000_000_000_000 ? value * 1000 : value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function sampleLatency(value: LinkQualitySample["latencyMs"]) {
  if (value == null || value === "") return null;
  const latency = Number(value);
  return Number.isFinite(latency) && latency >= 0 ? latency : null;
}

function percentile(values: number[], q: number) {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function round1(value: number | null) {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
}

export function filterLinkQualitySamples(samples: LinkQualitySample[] | undefined, hours: number, now = Date.now()) {
  const since = now - Math.max(0, hours) * 60 * 60 * 1000;
  return (samples || [])
    .filter((sample) => sampleTime(sample.recordedAt) >= since)
    .sort((a, b) => sampleTime(a.recordedAt) - sampleTime(b.recordedAt));
}

export function calculateLinkQuality(samples: LinkQualitySample[] | undefined): LinkQualityStats {
  const ordered = [...(samples || [])].sort((a, b) => sampleTime(a.recordedAt) - sampleTime(b.recordedAt));
  if (ordered.length === 0) {
    return {
      total: 0, success: 0, timeout: 0, availability: null, timeoutRate: null,
      currentLatency: null, currentIsTimeout: false, average: null, p50: null, p95: null,
      min: null, max: null, jitter: null, lastRecordedAt: null, lastFailureAt: null,
      consecutiveFailures: 0, status: "no-data",
    };
  }

  const successfulLatencies: number[] = [];
  let timeout = 0;
  let lastFailureAt: number | null = null;
  let consecutiveFailures = 0;

  for (const sample of ordered) {
    const latency = sampleLatency(sample.latencyMs);
    const isTimeout = sample.isTimeout === true || Number(sample.isTimeout) === 1 || latency == null;
    if (isTimeout) {
      timeout += 1;
      lastFailureAt = sampleTime(sample.recordedAt) || lastFailureAt;
    } else {
      successfulLatencies.push(latency);
    }
  }

  for (let i = ordered.length - 1; i >= 0; i--) {
    const latency = sampleLatency(ordered[i].latencyMs);
    const isTimeout = ordered[i].isTimeout === true || Number(ordered[i].isTimeout) === 1 || latency == null;
    if (!isTimeout) break;
    consecutiveFailures += 1;
  }

  const latest = ordered[ordered.length - 1];
  const latestLatency = sampleLatency(latest.latencyMs);
  const currentIsTimeout = latest.isTimeout === true || Number(latest.isTimeout) === 1 || latestLatency == null;
  const total = ordered.length;
  const success = total - timeout;
  const average = successfulLatencies.length
    ? successfulLatencies.reduce((sum, value) => sum + value, 0) / successfulLatencies.length
    : null;

  const deltas: number[] = [];
  for (let i = 1; i < successfulLatencies.length; i++) {
    deltas.push(Math.abs(successfulLatencies[i] - successfulLatencies[i - 1]));
  }
  const jitter = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0;
  const availability = total ? (success / total) * 100 : null;
  const timeoutRate = total ? (timeout / total) * 100 : null;
  const p95 = percentile(successfulLatencies, 0.95);

  let status: LinkQualityStats["status"] = "healthy";
  if (currentIsTimeout || (availability != null && availability < 95) || consecutiveFailures >= 2) {
    status = "degraded";
  } else if (
    (availability != null && availability < 99.5)
    || (average != null && p95 != null && p95 > Math.max(average * 1.8, average + 25))
    || (average != null && jitter > Math.max(15, average * 0.3))
  ) {
    status = "unstable";
  }

  return {
    total,
    success,
    timeout,
    availability: round1(availability),
    timeoutRate: round1(timeoutRate),
    currentLatency: currentIsTimeout ? null : round1(latestLatency),
    currentIsTimeout,
    average: round1(average),
    p50: round1(percentile(successfulLatencies, 0.5)),
    p95: round1(p95),
    min: successfulLatencies.length ? round1(Math.min(...successfulLatencies)) : null,
    max: successfulLatencies.length ? round1(Math.max(...successfulLatencies)) : null,
    jitter: round1(jitter),
    lastRecordedAt: sampleTime(latest.recordedAt) || null,
    lastFailureAt,
    consecutiveFailures,
    status,
  };
}

export function linkQualityStatusLabel(status: LinkQualityStats["status"]) {
  if (status === "healthy") return "稳定";
  if (status === "unstable") return "波动";
  if (status === "degraded") return "异常";
  return "无数据";
}
