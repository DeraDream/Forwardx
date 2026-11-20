#!/usr/bin/env node
/**
 * ForwardX self-hosted IP profile aggregator.
 *
 * Configure keys in an env file, then run:
 *   set -a; . /etc/forwardx/ip-profile.env; set +a
 *   node scripts/ip-profile-aggregate.mjs 1.1.1.1
 *
 * This script never sends credentials to Agents or browsers.
 */

const ip = process.argv[2]?.trim();
if (!ip) {
  console.error("Usage: node scripts/ip-profile-aggregate.mjs <IP>");
  process.exit(1);
}

const timeoutFetch = async (url, options = {}) => {
  const signal = AbortSignal.timeout(12_000);
  const response = await fetch(url, { ...options, signal, headers: { Accept: "application/json", "User-Agent": "ForwardX-IPProfile/1.0", ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

export function normalizeIpType(value) {
  const raw = String(value || "").trim();
  const lower = raw.toLowerCase();
  const code = (raw.match(/^\(([a-z]+)/i)?.[1] || lower.split(/[\s/]/)[0]).toLowerCase();
  if (["dch", "hosting"].includes(code) || /data.?center|web hosting|hosting/.test(lower)) return "机房";
  if (["isp", "lin", "lineisp"].includes(code) || /residential|fixed line/.test(lower)) return "家宽";
  if (["com", "business", "commercial"].includes(code) || /business|commercial|corporate/.test(lower)) return "商业";
  if (["mob", "mobile"].includes(code) || /mobile|cellular/.test(lower)) return "手机";
  if (code === "cdn" || lower === "cdn") return "CDN";
  if (["edu", "education"].includes(code) || /university|college|school|education/.test(lower)) return "教育";
  if (["gov", "government"].includes(code)) return "政府";
  if (["bank", "banking"].includes(code)) return "银行";
  if (["org", "organization"].includes(code)) return "组织";
  if (["mil", "military"].includes(code)) return "军队";
  if (["lib", "library"].includes(code)) return "图书馆";
  if (["ses", "spider"].includes(code) || /crawler|search engine spider/.test(lower)) return "爬虫";
  if (["rsv", "reserved"].includes(code)) return "保留";
  return raw ? "其他" : null;
}

const configured = (name) => String(process.env[name] || "").trim();
const result = (name, data = {}) => ({ name, status: "ok", ...data });
const unavailable = (name, reason) => ({ name, status: "unavailable", error: reason });
const failed = (name, error) => ({ name, status: "error", error: error instanceof Error ? error.message : String(error) });
const bool = (value) => typeof value === "boolean" ? value : null;
const score = (value, percent = false) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value) * (percent ? 100 : 1))) : null;

const providers = [
  async () => {
    try {
      const data = await timeoutFetch(`https://ipinfo.io/widget/demo/${encodeURIComponent(ip)}`);
      const item = data.data || {};
      return result("IPinfo", { networkTypeRaw: item.asn?.type || null, companyTypeRaw: item.company?.type || null, flags: { proxy: bool(item.privacy?.proxy), vpn: bool(item.privacy?.vpn), tor: bool(item.privacy?.tor), datacenter: bool(item.privacy?.hosting) } });
    } catch (error) { return failed("IPinfo", error); }
  },
  async () => {
    const key = configured("FORWARDX_IPREGISTRY_KEY");
    if (!key) return unavailable("ipregistry", "未配置 FORWARDX_IPREGISTRY_KEY");
    try {
      const data = await timeoutFetch(`https://api.ipregistry.co/${encodeURIComponent(ip)}?key=${encodeURIComponent(key)}`);
      return result("ipregistry", { networkTypeRaw: data.connection?.type || null, companyTypeRaw: data.company?.type || null, flags: { proxy: bool(data.security?.is_proxy), vpn: bool(data.security?.is_vpn), tor: bool(data.security?.is_tor ?? data.security?.is_tor_exit), datacenter: bool(data.security?.is_cloud_provider), abuser: bool(data.security?.is_abuser) } });
    } catch (error) { return failed("ipregistry", error); }
  },
  async () => {
    const key = configured("FORWARDX_IPAPI_KEY");
    if (!key) return unavailable("ipapi.is", "未配置 FORWARDX_IPAPI_KEY");
    try {
      const data = await timeoutFetch("https://api.ipapi.is", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: ip, key }) });
      return result("ipapi.is", { networkTypeRaw: data.asn?.type || null, companyTypeRaw: data.company?.type || null, score: score(String(data.company?.abuser_score || "").match(/[\d.]+/)?.[0], true), flags: { proxy: bool(data.is_proxy), vpn: bool(data.is_vpn), tor: bool(data.is_tor), datacenter: bool(data.is_datacenter), abuser: bool(data.is_abuser), bot: bool(data.is_crawler) } });
    } catch (error) { return failed("ipapi.is", error); }
  },
  async () => {
    const key = configured("FORWARDX_IP2LOCATION_KEY");
    if (!key) return unavailable("IP2Location", "未配置 FORWARDX_IP2LOCATION_KEY");
    try {
      const data = await timeoutFetch(`https://api.ip2location.io/?key=${encodeURIComponent(key)}&ip=${encodeURIComponent(ip)}&format=json`);
      return result("IP2Location", { networkTypeRaw: data.usage_type || null, companyTypeRaw: data.as_info?.as_usage_type || null, score: score(data.fraud_score), flags: { proxy: bool(data.is_proxy), vpn: bool(data.proxy?.is_vpn), tor: bool(data.proxy?.is_tor), datacenter: bool(data.proxy?.is_data_center), abuser: bool(data.proxy?.is_spammer), bot: bool(data.proxy?.is_web_crawler || data.proxy?.is_scanner || data.proxy?.is_botnet) } });
    } catch (error) { return failed("IP2Location", error); }
  },
  async () => {
    const key = configured("FORWARDX_ABUSEIPDB_KEY");
    if (!key) return unavailable("AbuseIPDB", "未配置 FORWARDX_ABUSEIPDB_KEY");
    try {
      const data = await timeoutFetch(`https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90&verbose=`, { headers: { Key: key } });
      return result("AbuseIPDB", { networkTypeRaw: data.data?.usageType || null, score: score(data.data?.abuseConfidenceScore), flags: { abuser: Number(data.data?.abuseConfidenceScore || 0) > 0 } });
    } catch (error) { return failed("AbuseIPDB", error); }
  },
  async () => {
    const key = configured("FORWARDX_SCAMALYTICS_KEY");
    if (!key) return unavailable("Scamalytics", "未配置 FORWARDX_SCAMALYTICS_KEY");
    try {
      const data = await timeoutFetch(`https://api11.scamalytics.com/${encodeURIComponent(key)}/?ip=${encodeURIComponent(ip)}`);
      const proxy = data.scamalytics_proxy || {};
      return result("Scamalytics", { score: score(data.scamalytics_score), flags: { proxy: bool(data.external_datasources?.firehol?.is_proxy), vpn: bool(proxy.is_vpn), tor: bool(data.external_datasources?.x4bnet?.is_tor), datacenter: bool(proxy.is_datacenter), abuser: bool(data.is_blacklisted_external) } });
    } catch (error) { return failed("Scamalytics", error); }
  },
  async () => {
    const key = configured("FORWARDX_DBIP_KEY");
    if (!key) return unavailable("DB-IP", "未配置 FORWARDX_DBIP_KEY");
    try {
      const data = await timeoutFetch(`https://api.db-ip.com/v2/${encodeURIComponent(key)}/${encodeURIComponent(ip)}`);
      const threat = String(data.threatLevel || "").toLowerCase();
      return result("DB-IP", { score: threat === "high" ? 100 : threat === "medium" ? 50 : threat === "low" ? 0 : null, flags: { proxy: bool(data.isProxy), bot: bool(data.isCrawler) } });
    } catch (error) { return failed("DB-IP", error); }
  },
  async () => {
    const key = configured("FORWARDX_IPDATA_KEY");
    if (!key) return unavailable("IPdata", "未配置 FORWARDX_IPDATA_KEY");
    try {
      const data = await timeoutFetch(`https://api.ipdata.co/${encodeURIComponent(ip)}?api-key=${encodeURIComponent(key)}`);
      return result("IPdata", { networkTypeRaw: data.asn?.type || null, flags: { proxy: bool(data.threat?.is_proxy), vpn: bool(data.threat?.is_known_attacker), tor: bool(data.threat?.is_tor), datacenter: bool(data.threat?.is_datacenter), abuser: bool(data.threat?.is_known_abuser), bot: bool(data.threat?.is_bogon) } });
    } catch (error) { return failed("IPdata", error); }
  },
  async () => {
    const key = configured("FORWARDX_IPQS_KEY");
    if (!key) return unavailable("IPQualityScore", "未配置 FORWARDX_IPQS_KEY");
    try {
      const data = await timeoutFetch(`https://www.ipqualityscore.com/api/json/ip/${encodeURIComponent(key)}/${encodeURIComponent(ip)}`);
      return result("IPQualityScore", { score: score(data.fraud_score), flags: { proxy: bool(data.proxy), vpn: bool(data.vpn || data.active_vpn), tor: bool(data.tor), datacenter: bool(data.hosting), abuser: bool(data.recent_abuse) } });
    } catch (error) { return failed("IPQualityScore", error); }
  },
  async () => {
    const key = configured("FORWARDX_PROXYCHECK_KEY");
    try {
      const suffix = key ? `&key=${encodeURIComponent(key)}` : "";
      const data = await timeoutFetch(`https://proxycheck.io/v2/${encodeURIComponent(ip)}?vpn=1&asn=1&risk=1&days=7${suffix}`);
      const item = data[ip] || {};
      return result("ProxyCheck", { networkTypeRaw: item.type || null, score: score(item.risk), flags: { proxy: String(item.proxy || "").toLowerCase() === "yes" } });
    } catch (error) { return failed("ProxyCheck", error); }
  },
];

const sources = await Promise.all(providers.map((provider) => provider()));
for (const source of sources) {
  source.networkType = normalizeIpType(source.networkTypeRaw);
  source.companyType = normalizeIpType(source.companyTypeRaw);
}
console.log(JSON.stringify({ ip, generatedAt: new Date().toISOString(), sources }, null, 2));
