import { queryRaw, executeRaw } from "./dbRuntime";

const b64 = (value: string) => Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const esc = (value: unknown) => JSON.stringify(String(value ?? ""));
function nameOf(link: string, fallback: string) { try { return decodeURIComponent(new URL(link).hash.slice(1)) || fallback; } catch { return fallback; } }
function decoded(value: string) { try { return b64(value); } catch { return value; } }
function list(value: string | null) { return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : undefined; }
function proxy(link: string, fallback: string): any | null {
  const protocol = link.slice(0, link.indexOf(":")).toLowerCase();
  try {
    if (protocol === "vmess") {
      const data = JSON.parse(b64(link.slice(8)));
      const tls = String(data.tls || "").toLowerCase();
      const ws = data.net === "ws" || data.net === "http" || data.net === "h2" ? { path: data.path || undefined, headers: data.host ? { Host: data.host } : undefined } : undefined;
      return { name: data.ps || fallback, type: "vmess", server: data.add, port: Number(data.port), uuid: data.id, alterId: Number(data.aid || 0), cipher: data.scy || "auto", tls: tls !== "" && tls !== "none", servername: data.sni || undefined, "client-fingerprint": data.fp || undefined, network: data.net || undefined, "ws-opts": ws, "grpc-opts": data.net === "grpc" ? { "grpc-service-name": data.path || undefined } : undefined, udp: true };
    }
    if (protocol === "ss") {
      let raw = link.slice(5).split(/[?#]/)[0];
      if (!raw.includes("@")) raw = decoded(raw);
      const url = new URL(`ss://${raw}`);
      let auth = url.password ? `${decodeURIComponent(url.username || "")}:${decodeURIComponent(url.password)}` : decodeURIComponent(url.username || "");
      if (!auth.includes(":")) auth = decoded(auth);
      const separator = auth.indexOf(":");
      if (separator < 1) return null;
      return { name: nameOf(link, fallback), type: "ss", server: url.hostname, port: Number(url.port), cipher: auth.slice(0, separator), password: auth.slice(separator + 1), udp: true };
    }
    if (protocol === "vless") {
      const url = new URL(link);
      const security = url.searchParams.get("security") || "none";
      const network = url.searchParams.get("type") || "tcp";
      const ws = network === "ws" || network === "http" || network === "h2" ? { path: url.searchParams.get("path") || undefined, headers: url.searchParams.get("host") ? { Host: url.searchParams.get("host") } : undefined } : undefined;
      return { name: nameOf(link, fallback), type: "vless", server: url.hostname, port: Number(url.port), uuid: url.username, tls: security !== "none", servername: url.searchParams.get("sni") || undefined, "client-fingerprint": url.searchParams.get("fp") || undefined, flow: url.searchParams.get("flow") || undefined, network, alpn: list(url.searchParams.get("alpn")), "reality-opts": security === "reality" ? { "public-key": url.searchParams.get("pbk") || undefined, "short-id": url.searchParams.get("sid") || undefined } : undefined, "ws-opts": ws, "grpc-opts": network === "grpc" ? { "grpc-service-name": url.searchParams.get("serviceName") || undefined, "grpc-mode": url.searchParams.get("mode") || undefined } : undefined, udp: true };
    }
    if (protocol === "ssr") {
      const body = b64(link.slice(6)); const [base, query = ""] = body.split("/?"); const pieces = base.split(":");
      if (pieces.length < 6) return null;
      const password64 = pieces.pop()!; const obfs = pieces.pop()!; const method = pieces.pop()!; const protocolName = pieces.pop()!; const port = pieces.pop()!; const server = pieces.join(":").replace(/^\[|\]$/g, "");
      const params = new URLSearchParams(query); const name = decoded(params.get("remarks") || "") || fallback;
      return { name, type: "ssr", server, port: Number(port), protocol: protocolName, cipher: method, obfs, "obfs-param": decoded(params.get("obfsparam") || "") || undefined, "protocol-param": decoded(params.get("protoparam") || "") || undefined, password: b64(password64), udp: true };
    }
  } catch { return null; }
  return null;
}
function yamlValue(value: any): string {
  if (Array.isArray(value)) return `[${value.map((v) => yamlValue(v)).join(", ")}]`;
  if (typeof value === "object" && value) return `{ ${Object.entries(value).filter(([, nested]) => nested !== undefined && nested !== "").map(([key, nested]) => `${key}: ${yamlValue(nested)}`).join(", ")} }`;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value == null || value === "") return "";
  return esc(value);
}
function clash(nodes: any[]) { return `proxies:\n${nodes.map((item) => `  - { ${Object.entries(item).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => `${key}: ${yamlValue(value)}`).join(", ")} }`).join("\n")}\n`; }
function egern(nodes: any[]) {
  return `# Egern Profile\nproxy:\n${nodes.filter((item) => item.type !== "ssr" && !(item.type === "vless" && item["reality-opts"])).map((item) => {
    const kind = item.type === "ss" ? "shadowsocks" : item.type;
    const fields: Record<string, unknown> = { name: item.name, server: item.server, port: item.port, tfo: false, udp_relay: true };
    if (item.type === "ss") Object.assign(fields, { method: item.cipher, password: item.password });
    if (item.type === "vmess") Object.assign(fields, { user_id: item.uuid, security: item.cipher, legacy: false });
    if (item.type === "vless") Object.assign(fields, { user_id: item.uuid });
    if (item.network === "ws") fields.transport = { [item.tls ? "wss" : "ws"]: { path: item["ws-opts"]?.path || "/", headers: item["ws-opts"]?.headers } };
    else if (item.tls) fields.transport = { tls: { sni: item.servername, skip_tls_verify: false } };
    return `  - ${kind}:\n${Object.entries(fields).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => `      ${key}: ${yamlValue(value)}`).join("\n")}`;
  }).join("\n")}\n`;
}
function loon(nodes: any[], raw: string[]) { return `# ForwardX proxy subscription\n[Proxy]\n${nodes.map((item, index) => item.type === "ss" ? `${item.name} = Shadowsocks,${item.server},${item.port},${item.cipher},${esc(item.password)},udp=true` : raw[index] || "").filter(Boolean).join("\n")}\n`; }

export async function renderProxySubscription(token: string, format: string, access?: { ip?: string; userAgent?: string }) {
  const rows = await queryRaw<any>("SELECT * FROM proxy_subscriptions WHERE token=? LIMIT 1", [token]);
  const sub = rows[0];
  if (!sub || sub.revoked || (sub.expiresAt && Number(sub.expiresAt) < Math.floor(Date.now() / 1000))) return null;
  if (Number(sub.accessLimit || 0) > 0 && Number(sub.accessCount || 0) >= Number(sub.accessLimit)) return null;
  const templateRow = sub.templateId ? (await queryRaw<any>("SELECT content, filename FROM proxy_templates WHERE id=? LIMIT 1", [sub.templateId]))[0] : null;
  // Existing subscriptions retain their old format query parameter; template-driven
  // subscriptions select their renderer from the single chosen template instead.
  if (templateRow) format = /loon/i.test(String(templateRow.filename)) ? "loon" : /egern/i.test(String(templateRow.filename)) ? "egern" : "clash";
  const allowed = JSON.parse(sub.formatsJson || "[]");
  if (!templateRow && !allowed.includes(format)) return null;
  const ids = JSON.parse(sub.nodeIdsJson || "[]").map(Number).filter(Number.isFinite);
  if (!ids.length) return "";
  const marks = ids.map(() => "?").join(",");
  const rowsNodes = await queryRaw<any>(`SELECT * FROM proxy_nodes WHERE enabled=? AND id IN (${marks})`, [true, ...ids]);
  const ordered = ids.map((id: number) => rowsNodes.find((node) => Number(node.id) === id)).filter(Boolean);
  if (format === "raw") {
    await executeRaw("UPDATE proxy_subscriptions SET accessCount=accessCount+1, updatedAt=? WHERE id=?", [Math.floor(Date.now() / 1000), sub.id]);
    await executeRaw("INSERT INTO proxy_subscription_logs (subscriptionId, subscriptionKind, ip, userAgent, format, accessedAt) VALUES (?, ?, ?, ?, ?, ?)", [sub.id, "config", String(access?.ip || "unknown").slice(0, 64), String(access?.userAgent || "").slice(0, 1000), format, Math.floor(Date.now() / 1000)]);
    return Buffer.from(ordered.map((node: any) => node.link).join("\n") + "\n").toString("base64");
  }
  const parsed = ordered.map((node: any) => proxy(node.link, node.name)).filter(Boolean);
  await executeRaw("UPDATE proxy_subscriptions SET accessCount=accessCount+1, updatedAt=? WHERE id=?", [Math.floor(Date.now() / 1000), sub.id]);
  await executeRaw("INSERT INTO proxy_subscription_logs (subscriptionId, subscriptionKind, ip, userAgent, format, accessedAt) VALUES (?, ?, ?, ?, ?, ?)", [sub.id, "config", String(access?.ip || "unknown").slice(0, 64), String(access?.userAgent || "").slice(0, 1000), format, Math.floor(Date.now() / 1000)]);
  const rendered = format === "clash" ? clash(parsed) : format === "egern" ? egern(parsed) : loon(parsed, ordered.map((node: any) => node.link));
  const templates = templateRow ? [templateRow] : await queryRaw<any>("SELECT content FROM proxy_templates WHERE format=? LIMIT 1", [format]);
  let template = String(templates[0]?.content || "");
  if (!template.includes("{{PROXY_NODES}}")) return rendered;
  const entries = format === "clash" ? rendered.replace(/^proxies:\n/, "") : format === "egern" ? rendered.replace(/^# Egern Profile\nproxy:\n/, "") : rendered.replace(/^# ForwardX proxy subscription\n\[Proxy\]\n/, "");
  template = template.replaceAll("{{PROXY_NODES}}", entries.trimEnd());
  const groups = JSON.parse(sub.strategyGroupsJson || "[]");
  for (const group of Array.isArray(groups) ? groups : []) {
    const selected = (group.nodeIds || []).map(Number).map((id: number) => ordered.find((node: any) => Number(node.id) === id)).filter(Boolean);
    const names = selected.map((node: any) => proxy(node.link, node.name)?.name || node.name).join(", ");
    template = template.replaceAll(`{{PROXY_GROUP:${String(group.name)}}}`, names);
  }
  return template;
}

/** A client-neutral Base64 subscription, kept separate from rendered profiles like SublinkX node subscriptions. */
export async function renderProxyNodeSubscription(token: string, access?: { ip?: string; userAgent?: string }) {
  const rows = await queryRaw<any>("SELECT * FROM proxy_node_subscriptions WHERE token=? LIMIT 1", [token]);
  const sub = rows[0];
  if (!sub || sub.revoked || (sub.expiresAt && Number(sub.expiresAt) < Math.floor(Date.now() / 1000))) return null;
  if (Number(sub.accessLimit || 0) > 0 && Number(sub.accessCount || 0) >= Number(sub.accessLimit)) return null;
  const ids = JSON.parse(sub.nodeIdsJson || "[]").map(Number).filter(Number.isFinite);
  const marks = ids.map(() => "?").join(",");
  const nodes = ids.length ? await queryRaw<any>(`SELECT * FROM proxy_nodes WHERE enabled=? AND id IN (${marks})`, [true, ...ids]) : [];
  const ordered = ids.map((id: number) => nodes.find((node) => Number(node.id) === id)).filter(Boolean);
  const timestamp = Math.floor(Date.now() / 1000);
  await executeRaw("UPDATE proxy_node_subscriptions SET accessCount=accessCount+1, updatedAt=? WHERE id=?", [timestamp, sub.id]);
  await executeRaw("INSERT INTO proxy_subscription_logs (subscriptionId, subscriptionKind, ip, userAgent, format, accessedAt) VALUES (?, ?, ?, ?, ?, ?)", [sub.id, "nodes", String(access?.ip || "unknown").slice(0, 64), String(access?.userAgent || "").slice(0, 1000), "raw", timestamp]);
  return Buffer.from(ordered.map((node: any) => node.link).join("\n") + (ordered.length ? "\n" : "")).toString("base64");
}
