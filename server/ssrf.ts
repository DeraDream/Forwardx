import { lookup } from "dns/promises";
import { BlockList, isIP } from "net";

type SafeOutboundOptions = {
  allowPrivate?: boolean;
  purpose?: string;
};

function blockedHostError(purpose: string, host: string) {
  return new Error(`${purpose} 不允许访问受限地址 ${host}`);
}

function normalizeHost(host: string) {
  return String(host || "").trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function isRestrictedIPv4(value: string, allowPrivate: boolean) {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 2) return true;
  if (a === 192 && b === 88 && parts[2] === 99) return true;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  if (allowPrivate) return false;
  return a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

// Numeric subnet checks handle every equivalent IPv6 representation.
const restrictedIpv6 = new BlockList();
restrictedIpv6.addAddress("::", "ipv6");
restrictedIpv6.addAddress("::1", "ipv6");
restrictedIpv6.addSubnet("::ffff:0:0", 96, "ipv6");
restrictedIpv6.addSubnet("fe80::", 10, "ipv6");
restrictedIpv6.addSubnet("fec0::", 10, "ipv6");
restrictedIpv6.addSubnet("ff00::", 8, "ipv6");
restrictedIpv6.addSubnet("2001:db8::", 32, "ipv6");
const privateIpv6 = new BlockList();
privateIpv6.addSubnet("fc00::", 7, "ipv6");

export function isRestrictedOutboundIp(value: string, allowPrivate = false) {
  const version = isIP(value);
  if (version === 4) return isRestrictedIPv4(value, allowPrivate);
  if (version === 6) {
    return restrictedIpv6.check(value, "ipv6")
      || (!allowPrivate && privateIpv6.check(value, "ipv6"));
  }
  return true;
}

export async function assertSafeOutboundHost(rawHost: string, options: SafeOutboundOptions = {}) {
  const purpose = options.purpose || "此请求";
  const host = normalizeHost(rawHost);
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw blockedHostError(purpose, host || "-");
  }
  const allowPrivate = options.allowPrivate === true;
  if (isIP(host)) {
    if (isRestrictedOutboundIp(host, allowPrivate)) throw blockedHostError(purpose, host);
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`${purpose} 无法解析目标地址 ${host}`);
  }
  if (records.length === 0 || records.some((record) => isRestrictedOutboundIp(record.address, allowPrivate))) {
    throw blockedHostError(purpose, host);
  }
}

export async function assertSafeOutboundUrl(rawUrl: string, options: SafeOutboundOptions = {}) {
  let url: URL;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error(`${options.purpose || "此请求"} 地址无效`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${options.purpose || "此请求"} 仅支持 HTTP/HTTPS 地址`);
  }
  if (url.username || url.password) {
    throw new Error(`${options.purpose || "此请求"} 不允许 URL 内嵌账号信息`);
  }
  await assertSafeOutboundHost(url.hostname, options);
  return url;
}

export async function assertSafePluginHttpUrl(rawUrl: string) {
  const allowPrivate = /^(1|true|yes|on)$/i.test(String(process.env.FORWARDX_ALLOW_PRIVATE_PLUGIN_HTTP || ""));
  return assertSafeOutboundUrl(rawUrl, { allowPrivate, purpose: "插件 HTTP 请求" });
}
