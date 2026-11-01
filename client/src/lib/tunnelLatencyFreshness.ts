import { linkQualitySampleTime } from "./linkQuality";

/** Parallel Agents report independently; results older than two cycles are not current health. */
export function isFreshTunnelLatency(value: string | number | Date | null | undefined, now = Date.now()) {
  const timestamp = linkQualitySampleTime(value);
  return timestamp > 0 && timestamp <= now + 30_000 && now - timestamp <= 120_000;
}
