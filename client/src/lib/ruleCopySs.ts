export type CopySsHostMode = "landing" | "entry";

/** Copy-only URI: the chosen host does not change the deployed landing service. */
export function buildFinalLandingSsUri(
  service: { endpoint?: string | null; host?: { exitIp?: string | null; ip?: string | null } | null; method?: string | null; password?: string | null; port?: number | null; name?: string | null },
  mode: CopySsHostMode,
  entryAddress?: string | null,
): string {
  const host = String(mode === "entry" ? entryAddress : service.endpoint || service.host?.exitIp || service.host?.ip || "").trim();
  if (!host || !service.method || !service.password || !Number.isInteger(service.port) || Number(service.port) < 1 || Number(service.port) > 65535) return "";
  const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const credentials = btoa(unescape(encodeURIComponent(`${service.method}:${service.password}`)))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  return `ss://${credentials}@${address}:${service.port}#${encodeURIComponent(String(service.name || ""))}`;
}
