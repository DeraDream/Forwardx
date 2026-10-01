import { useMemo, useState } from "react";
import { Activity, ExternalLink, Globe2, Mail, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";

type Family = "ipv4" | "ipv6";

function statusBadge(status: string) {
  if (status === "error") return <Badge className="border-red-200 bg-red-500/10 text-red-700">检测错误</Badge>;
  if (status === "blocked") return <Badge className="border-red-200 bg-red-500/15 text-red-700 dark:text-red-300">屏蔽</Badge>;
  if (status === "partial") return <Badge className="border-amber-200 bg-amber-500/15 text-amber-700 dark:text-amber-300">部分解锁</Badge>;
  if (status === "unsupported") return <Badge className="border-border bg-muted/60 text-muted-foreground">不支持</Badge>;
  if (status === "info") return <Badge className="border-sky-200 bg-sky-500/10 text-sky-700 dark:text-sky-300">信息</Badge>;
  if (status === "app_only") return <Badge className="border-amber-200 bg-amber-500/15 text-amber-700 dark:text-amber-300">仅 App</Badge>;
  if (status === "web_only") return <Badge className="border-amber-200 bg-amber-500/15 text-amber-700 dark:text-amber-300">仅 Web</Badge>;
  return <Badge className="border-emerald-200 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">解锁</Badge>;
}

function statusCardClass(status: string) {
  if (status === "error" || status === "blocked") return "border-red-200/80 bg-red-500/5";
  if (status === "partial" || status === "app_only" || status === "web_only") return "border-amber-200/80 bg-amber-500/5";
  if (status === "unsupported") return "border-border bg-muted/25";
  if (status === "info") return "border-sky-200/80 bg-sky-500/5";
  return "border-emerald-200/80 bg-emerald-500/5";
}

function riskLevelText(level: unknown) {
  const labels: Record<string, string> = {
    very_low: "极低风险",
    low: "低风险",
    medium: "中等风险",
    elevated: "较高风险",
    high: "高风险",
    very_high: "极高风险",
    suspicious: "可疑 IP",
    risky: "存在风险",
    block: "建议封禁",
    unknown: "无数据",
  };
  return labels[String(level || "unknown")] || "无数据";
}

function riskLevelBadgeClass(level: unknown) {
  const value = String(level || "unknown");
  if (["very_low", "low"].includes(value)) return "border-emerald-200 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  if (["medium", "elevated", "suspicious"].includes(value)) return "border-amber-200 bg-amber-500/15 text-amber-700 dark:text-amber-300";
  if (["high", "very_high", "risky", "block"].includes(value)) return "border-red-200 bg-red-500/15 text-red-700 dark:text-red-300";
  return "border-border bg-muted/40 text-muted-foreground";
}

function riskScoreText(source: any) {
  const score = Number(source?.score);
  if (!Number.isFinite(score)) return "—";
  if (String(source?.name || "").toLowerCase().includes("ipapi")) return `${score.toFixed(2)}%`;
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

function normalizeRegionCode(value: unknown) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  if (/^[A-Z]{2}$/.test(raw)) return raw;

  const alpha3: Record<string, string> = {
    SGP: "SG", USA: "US", HKG: "HK", CHN: "CN", JPN: "JP", KOR: "KR",
    TWN: "TW", GBR: "GB", DEU: "DE", CAN: "CA", AUS: "AU", FRA: "FR",
    IND: "IN", NLD: "NL", CHE: "CH", SWE: "SE", NOR: "NO", FIN: "FI",
  };
  if (alpha3[raw]) return alpha3[raw];

  const names: Array<[RegExp, string]> = [
    [/^SINGAPORE\b/, "SG"],
    [/^UNITED STATES\b|^USA\b/, "US"],
    [/^HONG KONG\b/, "HK"],
    [/^CHINA\b/, "CN"],
    [/^JAPAN\b/, "JP"],
    [/^SOUTH KOREA\b|^KOREA\b/, "KR"],
    [/^TAIWAN\b/, "TW"],
    [/^UNITED KINGDOM\b|^GREAT BRITAIN\b/, "GB"],
    [/^GERMANY\b/, "DE"],
    [/^CANADA\b/, "CA"],
    [/^AUSTRALIA\b/, "AU"],
    [/^FRANCE\b/, "FR"],
    [/^INDIA\b/, "IN"],
  ];
  for (const [pattern, code] of names) {
    if (pattern.test(raw)) return code;
  }
  return "";
}

function appRegionClass(region: unknown, baseCountry: string, status: string) {
  const code = String(region || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "text-muted-foreground";
  if (status === "blocked" || status === "error") return "text-red-600 dark:text-red-400";
  if (code === "CN" && baseCountry && baseCountry !== "CN") return "font-semibold text-red-600 dark:text-red-400";
  if (baseCountry && code === baseCountry) return "font-semibold text-emerald-600 dark:text-emerald-400";
  if (baseCountry && code !== baseCountry) return "font-semibold text-amber-600 dark:text-amber-300";
  return "font-medium text-emerald-600 dark:text-emerald-400";
}

function unlockMethodBadge(method: unknown) {
  const value = String(method || "").toLowerCase();
  if (value === "dns") return <Badge className="border-amber-200 bg-amber-500/15 text-amber-700 dark:text-amber-300">DNS</Badge>;
  if (value === "native") return <Badge className="border-emerald-200 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">原生</Badge>;
  return <span className="text-muted-foreground">—</span>;
}

function ipTypeLabel(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "—";
  const lower = raw.toLowerCase();
  const code = raw.match(/^\(([A-Za-z]+)\)/)?.[1]?.toLowerCase() || "";

  if (code === "dch" || lower.includes("data center") || lower.includes("datacenter") || lower.includes("web hosting") || lower === "hosting") return "机房";
  if (code === "isp" || code === "lin" || lower === "isp" || lower.includes("fixed line isp") || lower.includes("residential") || lower === "consumer") return "家宽";
  if (code === "com" || lower === "business" || lower === "commercial" || lower.includes("commercial") || lower === "corporate") return "商业";
  if (code === "mob" || lower.includes("mobile isp") || lower === "mobile" || lower === "cellular") return "手机";
  if (code === "cdn" || lower.includes("content delivery network") || lower === "cdn") return "CDN";
  if (code === "edu" || lower === "education" || lower === "college" || lower === "school") return "教育";
  if (code === "gov" || lower === "government") return "政府";
  if (code === "mil" || lower === "military") return "军队";
  if (code === "lib" || lower === "library") return "图书馆";
  if (code === "org" || lower === "organization") return "组织";
  if (code === "rsv" || lower === "reserved") return "保留";
  if (lower === "traveler") return "漫游";
  if (lower === "router") return "路由";
  if (code === "ses" || lower.includes("search engine spider")) return "蜘蛛";
  if (lower === "dyn" || lower === "dynamic") return "动态";
  if (lower === "banking") return "银行";
  return raw;
}

function ipTypeBadgeClass(value: unknown) {
  const label = ipTypeLabel(value);
  if (label === "机房" || label === "CDN") return "border-red-200 bg-red-500/15 text-red-700 dark:text-red-300";
  if (label === "家宽" || label === "手机") return "border-emerald-200 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  if (label === "—") return "border-border bg-muted/30 text-muted-foreground";
  return "border-amber-200 bg-amber-500/15 text-amber-700 dark:text-amber-300";
}

function coordinateDMS(value: unknown, latitude: boolean) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  const absolute = Math.abs(number);
  const degrees = Math.floor(absolute);
  const minutesFloat = (absolute - degrees) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = Math.round((minutesFloat - minutes) * 60);
  const direction = latitude ? (number >= 0 ? "N" : "S") : (number >= 0 ? "E" : "W");
  return `${degrees}°${minutes}′${seconds}″${direction}`;
}

export function HostNetworkProfileDialog({
  hostId,
  hostName,
  open,
  onOpenChange,
}: {
  hostId: number;
  hostName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [family, setFamily] = useState<Family>("ipv4");
  const [bgpFullscreen, setBgpFullscreen] = useState(false);
  const query = trpc.networkProfile.status.useQuery(
    { hostId },
    { enabled: open && hostId > 0, refetchInterval: open ? 800 : false, refetchOnWindowFocus: false },
  );
  const start = trpc.networkProfile.start.useMutation({
    onError: (error) => toast.error(error.message),
    onSuccess: () => void query.refetch(),
  });
  const familyView = family === "ipv4" ? query.data?.ipv4 : query.data?.ipv6;
  const current = familyView?.running || familyView?.persisted;
  const running = familyView?.running?.status === "running";
  const anyRunning = query.data?.ipv4?.running?.status === "running" || query.data?.ipv6?.running?.status === "running";
  const data = current?.data || {};
  const identity = data.identity || {};
  const risk = data.risk || {};
  const bgpGraphPath = String(data.network?.bgpGraphPath || "").trim();
  const bgpPrefix = String(data.network?.prefix || "").trim();
  const embeddedBGPGraphDataUrl = String(data.network?.bgpGraphDataUrl || "").trim();
  const bgpRevision = String(current?.taskId || current?.updatedAt || "");
  const bgpGraphQuery = trpc.networkProfile.bgpGraph.useQuery(
    { hostId, family, revision: bgpRevision },
    {
      enabled: open && hostId > 0 && !embeddedBGPGraphDataUrl && !!(bgpGraphPath || bgpPrefix),
      staleTime: 0,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  );
  const bgpDisplayDataUrl = embeddedBGPGraphDataUrl || String(bgpGraphQuery.data?.dataUrl || "");
  const apps = useMemo(() => Object.values(data.apps || {}) as any[], [data.apps]);
  const appSections = useMemo(() => {
    const aiIds = new Set(["chatgpt", "claude", "gemini", "grok", "perplexity"]);
    const buckets = new Map<string, { key: string; title: string; order: number; items: any[] }>();
    for (const app of apps) {
      const id = String(app?.id || "");
      const category = String(app?.category || (aiIds.has(id) ? "ai" : "global"));
      const group = String(app?.group || (category === "ai" ? "AI 平台" : category === "regional" ? "区域平台" : "跨国平台"));
      const subgroup = String(app?.subgroup || "").trim();
      const title = subgroup ? `${group} · ${subgroup}` : group;
      const order = category === "ai" ? 0 : category === "global" ? 1 : category === "regional" ? 2 : 3;
      const key = `${order}:${title}`;
      const currentBucket = buckets.get(key) || { key, title, order, items: [] };
      currentBucket.items.push(app);
      buckets.set(key, currentBucket);
    }
    return Array.from(buckets.values())
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
      .map((section) => ({
        ...section,
        items: section.items.sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || ""))),
      }));
  }, [apps]);
  const steps = current?.steps || {};
  const completed = Object.values(steps).filter((item: any) => ["success", "error", "skip"].includes(item?.status)).length;
  const total = Math.max(6, Object.keys(steps).length);
  const progress = Math.min(100, Math.round((completed / total) * 100));
  const detectedIp = data.ip?.address || identity.ip || (family === "ipv4" ? query.data?.host.ipv4 : query.data?.host.ipv6);
  const ixpItems = Array.isArray(data.network?.ixp) ? data.network.ixp : [];
  const ixpNames = ixpItems.map((item: any) => typeof item === "string" ? item : item?.name).filter(Boolean);
  const bgpToolsIXPCount = Number.isFinite(Number(data.network?.bgpToolsIXPCount)) ? Number(data.network.bgpToolsIXPCount) : null;
  const ixpText = ixpNames.length
    ? ixpNames.join(" · ")
    : bgpToolsIXPCount !== null
      ? (bgpToolsIXPCount > 0 ? "BGP.Tools 检测到 " + bgpToolsIXPCount + " 个 IXP 路由接入" : "BGP.Tools 未检测到 IXP 路由接入")
      : data.network?.registered === false
        ? "PeeringDB 未登记"
        : Number(data.network?.ixCount) === 0
          ? "无 IXP 登记"
          : Array.isArray(data.network?.warnings) && data.network.warnings.some((item: any) => String(item).startsWith("PeeringDB:"))
            ? "IXP 检测失败"
            : "无数据";
  const rpkiText: Record<string, string> = { valid: "有效", invalid_asn: "ASN 不匹配", invalid_length: "前缀长度无效", unknown: "未配置 ROA" };
  const neighbours = Array.isArray(data.network?.neighbours) ? data.network.neighbours : [];
  const ipNatureText: Record<string, string> = { native: "原生 IP", broadcast: "广播 IP", unknown: "证据不足" };
  const geoEvidence = Array.isArray(identity.ipNatureGeoEvidence) ? identity.ipNatureGeoEvidence : [];
  const registeredEvidence = Array.isArray(identity.ipNatureRegisteredEvidence) ? identity.ipNatureRegisteredEvidence : [];
  const evidenceText = (items: any[]) => items
    .map((item: any) => [item?.provider, item?.country].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(" · ");
  const ipinfoBasic = identity.ipinfoBasic || {};
  const rawBasicProvider = String(identity.basicProvider || "");
  const basicProvider = rawBasicProvider && rawBasicProvider !== "MaxMind"
    ? rawBasicProvider
    : (Object.keys(ipinfoBasic).length ? "IPinfo" : "ipwho.is");
  const basic = ipinfoBasic;
  const basicLat = Number(basic.latitude ?? identity.latitude);
  const basicLon = Number(basic.longitude ?? identity.longitude);
  const hasCoordinates = Number.isFinite(basicLat) && Number.isFinite(basicLon);
  const coordinateText = hasCoordinates
    ? `${coordinateDMS(basicLon, false)}, ${coordinateDMS(basicLat, true)}`
    : "无数据";
  const mapUrl = hasCoordinates
    ? `https://check.place/${basicLat},${basicLon},${Number(basic.accuracyRadius) || 1001},cn`
    : "";
  const cityText = [basic.subdivision || identity.region, basic.city || identity.city, basic.postalCode || identity.postalCode].filter(Boolean).join(" · ");
  const usageCode = String(basic.countryCode || identity.actualCountryCode || identity.countryCode || "").toUpperCase();
  const registeredCode = String(basic.registeredCountryCode || identity.registeredCountryCode || "").toUpperCase();
  const usageText = [
    usageCode ? `[${usageCode}]` : "",
    basic.country || identity.country,
    basic.continentCode ? `[${basic.continentCode}]` : "",
    basic.continent || identity.continent,
  ].filter(Boolean).join(" ");
  const registeredText = [
    registeredCode ? `[${registeredCode}]` : "",
    basic.registeredCountry,
  ].filter(Boolean).join(" ");
  const baseCountry = usageCode;
  const riskSources = Array.isArray(risk.sources) ? risk.sources : [];
  const riskOrder = ["ProxyCheck", "FFraud", "IP99", "IP2Location", "AbuseIPDB"];
  const scoredRiskSources = riskOrder
    .map((name) => riskSources.find((item: any) => item?.name === name))
    .filter((source: any) => source && Number.isFinite(Number(source?.score)));
  // Keep the type matrix to the selected practical sources. ipapi.is is
  // queried only when its API key has been saved in System Settings.
  const typeSources = [
    { name: "IPinfo", source: riskSources.find((item: any) => item?.name === "IPinfo") },
    { name: "ipregistry", source: riskSources.find((item: any) => item?.name === "ipregistry") },
    { name: "ipapi.is", source: riskSources.find((item: any) => item?.name === "ipapi.is") },
    { name: "IP2Location", source: riskSources.find((item: any) => item?.name === "IP2Location") },
  ];
  const mail = data.mail || {};
  const mailProviders = Array.isArray(mail.providers) ? mail.providers : [];
  const dnsbl = mail.dnsbl || {};
  const relationClass = (relation: string, index: number) => {
    const value = String(relation || "").toLowerCase();
    if (value.includes("left")) return "border-sky-300 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    if (value.includes("right")) return "border-emerald-300 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    const palette = [
      "border-violet-300 bg-violet-500/10 text-violet-700 dark:text-violet-300",
      "border-amber-300 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      "border-cyan-300 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
      "border-rose-300 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    ];
    return palette[index % palette.length];
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Globe2 className="h-5 w-5" />网络画像 · {hostName || query.data?.host.name || `主机 #${hostId}`}</DialogTitle>
          <DialogDescription>快速检测当前协议族；完整检测会同时检测可用的 IPv4 / IPv6，并按出口国家自动选择区域流媒体项目。</DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          {(["ipv4", "ipv6"] as Family[]).map((item) => (
            <Button key={item} variant={family === item ? "default" : "outline"} size="sm" onClick={() => setFamily(item)}>
              {item === "ipv4" ? "IPv4" : "IPv6"}
              {item === "ipv4" && query.data?.host.ipv4 ? <span className="ml-1 max-w-36 truncate font-mono text-[10px] opacity-80">{query.data.host.ipv4}</span> : null}
              {item === "ipv6" && query.data?.host.ipv6 ? <span className="ml-1 max-w-36 truncate font-mono text-[10px] opacity-80">{query.data.host.ipv6}</span> : null}
            </Button>
          ))}
        </div>

        {running && (
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between text-xs"><span className="flex items-center gap-1.5"><Activity className="h-3.5 w-3.5 animate-pulse" />正在检测，结果会实时出现</span><span>{progress}%</span></div>
            <Progress value={progress} />
          </div>
        )}

        {!current ? (
          <div className="rounded-lg border border-dashed py-14 text-center text-sm text-muted-foreground">该协议族还没有检测记录。</div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-sky-200/60 bg-sky-500/[0.025] p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium text-sky-700 dark:text-sky-300">基础信息</div>
                <Badge variant="outline">数据源：{basicProvider}</Badge>
              </div>
              <div className="grid gap-x-5 gap-y-1.5 text-xs sm:grid-cols-2">
                <div><span className="text-muted-foreground">IP：</span><span className="font-mono font-semibold text-sky-700 dark:text-sky-300">{detectedIp || "无数据"}</span></div>
                <div><span className="text-muted-foreground">自治系统号：</span><span className="font-medium">{basic.asn ? `AS${basic.asn}` : identity.asnNumber ? `AS${identity.asnNumber}` : identity.asn || "无数据"}</span></div>
                <div className="sm:col-span-2"><span className="text-muted-foreground">组织：</span><span className="font-medium">{basic.organization || identity.company || identity.isp || "无数据"}</span></div>
                <div className="sm:col-span-2"><span className="text-muted-foreground">坐标：</span><span className="font-mono">{coordinateText}</span></div>
                <div className="sm:col-span-2">
                  <span className="text-muted-foreground">地图：</span>
                  {mapUrl ? <a href={mapUrl} target="_blank" rel="noreferrer" className="font-medium text-sky-700 underline decoration-dotted underline-offset-2 dark:text-sky-300">{mapUrl}</a> : <span>无坐标数据</span>}
                </div>
                <div><span className="text-muted-foreground">城市：</span><span className="font-medium">{cityText || "无数据"}</span></div>
                <div><span className="text-muted-foreground">时区：</span><span className="font-medium">{basic.timezone || identity.timezone || "无数据"}</span></div>
                <div><span className="text-muted-foreground">使用地：</span><span className="font-medium text-emerald-700 dark:text-emerald-300">{usageText || "无数据"}</span></div>
                <div><span className="text-muted-foreground">注册地：</span><span className={registeredCode ? "font-medium text-emerald-700 dark:text-emerald-300" : "font-medium text-muted-foreground"}>{registeredText || "无注册地址数据"}</span></div>
                <div>
                  <span className="text-muted-foreground">IP 类型：</span>
                  <span className={identity.ipNature === "broadcast" ? "font-semibold text-red-600 dark:text-red-400" : identity.ipNature === "native" ? "font-semibold text-emerald-600 dark:text-emerald-400" : "font-medium text-amber-700 dark:text-amber-300"}>
                    {ipNatureText[String(identity.ipNature || "unknown")] || "证据不足"}
                  </span>
                </div>
                <div><span className="text-muted-foreground">网络域名：</span><span className="font-medium">{identity.domain || "无数据"}</span></div>
              </div>

              {(identity.ipNatureReason || geoEvidence.length > 0 || registeredEvidence.length > 0) && (
                <div className="mt-3 rounded-md border border-sky-100/70 bg-background/60 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground dark:border-sky-900/40">
                  {identity.ipNatureReason ? <div>{identity.ipNatureReason}</div> : null}
                  {geoEvidence.length > 0 ? <div title={evidenceText(geoEvidence)}>使用地证据：{evidenceText(geoEvidence)}</div> : null}
                  {registeredEvidence.length > 0 ? <div title={evidenceText(registeredEvidence)}>注册地证据：{evidenceText(registeredEvidence)}</div> : null}
                </div>
              )}

              <div className="mt-4 border-t pt-3">
                <div className="mb-2 text-sm font-medium text-fuchsia-700 dark:text-fuchsia-300">IP 类型属性</div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[620px] text-xs">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="py-2 text-left font-medium">数据库</th>
                        {typeSources.map((item) => <th key={item.name} className="px-2 py-2 text-center font-medium">{item.name}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b">
                        <td className="py-2 text-muted-foreground">使用类型</td>
                        {typeSources.map((item) => (
                          <td key={item.name} className="px-2 py-2 text-center">
                            {item.source?.networkType ? (
                              <div className="flex flex-col items-center gap-1">
                                <Badge variant="outline" className={ipTypeBadgeClass(item.source.networkType)}>{ipTypeLabel(item.source.networkType)}</Badge>
                              </div>
                            ) : item.name === "ipapi.is" && String(item.source?.error || "").toLowerCase().includes("api key")
                              ? <span className="text-[10px] text-amber-700 dark:text-amber-300" title={item.source?.error}>需 API Key</span>
                              : item.source?.error
                                ? <span className="text-[10px] text-red-600 dark:text-red-400" title={item.source.error}>检测失败</span>
                                : <span className="text-[10px] text-muted-foreground">未返回</span>}
                          </td>
                        ))}
                      </tr>
                      <tr>
                        <td className="py-2 text-muted-foreground">公司类型</td>
                        {typeSources.map((item) => (
                          <td key={item.name} className="px-2 py-2 text-center">
                            {item.source?.companyType ? (
                              <div className="flex flex-col items-center gap-1">
                                <Badge variant="outline" className={ipTypeBadgeClass(item.source.companyType)}>{ipTypeLabel(item.source.companyType)}</Badge>
                              </div>
                            ) : item.name === "ipapi.is" && String(item.source?.error || "").toLowerCase().includes("api key")
                              ? <span className="text-[10px] text-amber-700 dark:text-amber-300" title={item.source?.error}>需 API Key</span>
                              : item.source?.error
                                ? <span className="text-[10px] text-red-600 dark:text-red-400" title={item.source.error}>检测失败</span>
                                : <span className="text-[10px] text-muted-foreground">未返回</span>}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-amber-200/70 bg-amber-500/[0.025] p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300"><ShieldCheck className="h-4 w-4" />IP 风险</div>
                <span className="text-[10px] text-muted-foreground">仅展示真实直连数据库评分；无评分来源自动隐藏</span>
              </div>
              {scoredRiskSources.length === 0 ? (
                <div className="rounded-md border border-dashed py-4 text-center text-xs text-muted-foreground">暂无可用风险评分</div>
              ) : (
                <div className="grid grid-cols-[96px_minmax(0,1fr)_54px_72px] items-center gap-x-2 gap-y-2.5 text-xs">
                  <div />
                  <div>
                    <div className="grid grid-cols-5 text-center text-[10px] text-muted-foreground">
                      <span>极低</span><span>低</span><span>中等</span><span>高</span><span>极高</span>
                    </div>
                    <div className="mt-1 flex h-3 overflow-hidden rounded-full">
                      <span className="w-1/5 bg-emerald-500/70" />
                      <span className="w-1/5 bg-emerald-400/70" />
                      <span className="w-1/5 bg-amber-400/80" />
                      <span className="w-1/5 bg-orange-500/80" />
                      <span className="w-1/5 bg-red-500/80" />
                    </div>
                  </div>
                  <div />
                  <div />
                  {scoredRiskSources.map((source: any) => {
                    const score = Number(source?.score);
                    const hasScore = Number.isFinite(score);
                    const marker = hasScore ? Math.max(0, Math.min(100, score)) : 0;
                    return (
                      <div key={source.name} className="contents">
                        <div className="min-w-0 font-medium">{source.name}</div>
                        <div className="relative h-3 rounded-full bg-muted">
                          <div className="absolute inset-0 flex overflow-hidden rounded-full opacity-70">
                            <span className="w-1/5 bg-emerald-500/70" />
                            <span className="w-1/5 bg-emerald-400/70" />
                            <span className="w-1/5 bg-amber-400/80" />
                            <span className="w-1/5 bg-orange-500/80" />
                            <span className="w-1/5 bg-red-500/80" />
                          </div>
                          {hasScore ? (
                            <>
                              <span className="absolute inset-y-0 right-0 rounded-r-full bg-muted" style={{ width: `${100 - marker}%` }} />
                              <span className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-sm" style={{ left: `${marker}%` }} />
                            </>
                          ) : null}
                        </div>
                        <div className="text-right font-mono">{riskScoreText(source)}</div>
                        <Badge variant="outline" title={source.error || ""} className={`justify-self-end ${riskLevelBadgeClass(source.level)}`}>{riskLevelText(source.level)}</Badge>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-violet-200/60 bg-violet-500/[0.025] p-3">
              <div className="mb-1 flex items-center justify-between">
                <div className="text-sm font-medium text-violet-700 dark:text-violet-300">流媒体 / AI 解锁</div>
                <span className="text-xs text-muted-foreground">{apps.length ? `${apps.length} 项已返回` : "检测中"}</span>
              </div>
              <div className="mb-3 text-[11px] text-muted-foreground">
                AI 平台使用 ForwardX 原有检测；流媒体参考 RegionRestrictionCheck，并根据当前出口使用地自动检测跨国平台与对应区域平台。
              </div>
              <div className="space-y-3">
                {appSections.map((section) => (
                  <div key={section.key}>
                    <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-violet-700 dark:text-violet-300">
                      <span>{section.title}</span>
                      <span className="text-[10px] font-normal text-muted-foreground">{section.items.length} 项</span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                      {section.items.map((app: any) => {
                        const status = String(app.status || "unknown");
                        const region = normalizeRegionCode(app.region);
                        const value = String(app.value || "").trim();
                        const showResultValue = status === "info" || status === "partial" || status === "unsupported";
                        return (
                          <div key={app.id} className={`min-h-20 rounded-md border px-3 py-2 ${statusCardClass(status)}`}>
                            <div className="flex items-center justify-between gap-2">
                              <div className="truncate text-sm font-medium" title={app.name || app.id}>{app.name || app.id}</div>
                              {statusBadge(status)}
                            </div>
                            <div className="mt-1.5 space-y-0.5 text-[10px] leading-5">
                              {showResultValue && value ? (
                                <div className="flex min-w-0"><span className="inline-block w-11 shrink-0 text-muted-foreground">结果</span><span className="truncate" title={value}>{value}</span></div>
                              ) : (
                                <div><span className="inline-block w-11 text-muted-foreground">地区</span><span className={appRegionClass(region, baseCountry, status)}>{region || "—"}</span></div>
                              )}
                              <div className="flex items-center"><span className="inline-block w-11 shrink-0 text-muted-foreground">方式</span>{unlockMethodBadge(app.unlockMethod)}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {apps.length === 0 && <div className="py-5 text-center text-xs text-muted-foreground">检测开始后会逐项显示。</div>}
              </div>
            </div>

            {data.mail ? (
              <div className="rounded-lg border border-rose-200/60 bg-rose-500/[0.02] p-3">
                <div className="mb-3 flex items-center gap-2 text-sm font-medium text-rose-700 dark:text-rose-300"><Mail className="h-4 w-4" />邮局连通性 / IP 黑名单</div>
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground">25 端口出站：</span>
                  {mail.outbound25?.available === true
                    ? <Badge className="border-emerald-200 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">可用</Badge>
                    : <Badge className="border-red-200 bg-red-500/15 text-red-700 dark:text-red-300">阻断</Badge>}
                </div>
                <div className="grid gap-1.5 sm:grid-cols-3 md:grid-cols-4">
                  {mailProviders.map((provider: any) => (
                    <div key={provider.name} title={provider.detail || ""} className="flex items-center justify-between rounded-md border bg-background/60 px-2 py-1.5 text-xs">
                      <span>{provider.name}</span>
                      <Badge className={provider.available ? "border-emerald-200 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "border-red-200 bg-red-500/15 text-red-700 dark:text-red-300"}>{provider.available ? "+" : "−"}</Badge>
                    </div>
                  ))}
                </div>
                <div className="mt-3 rounded-md border bg-background/60 p-2.5 text-xs">
                  {dnsbl.supported === false ? (
                    <div className="text-muted-foreground">{dnsbl.reason || "DNSBL 不适用于当前协议族"}</div>
                  ) : (
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      <span>IP 黑名单数据库</span>
                      <span className="text-sky-700 dark:text-sky-300">有效 {dnsbl.total ?? 0}</span>
                      <span className="text-emerald-700 dark:text-emerald-300">正常 {dnsbl.clean ?? 0}</span>
                      <span className="text-amber-700 dark:text-amber-300">已标记 {dnsbl.marked ?? 0}</span>
                      <span className="font-semibold text-red-700 dark:text-red-300">黑名单 {dnsbl.blacklisted ?? 0}</span>
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            <div className="rounded-lg border border-cyan-200/60 bg-cyan-500/[0.025] p-3">
              <div className="mb-2 text-sm font-medium text-cyan-700 dark:text-cyan-300">网络 / IXP</div>
              <div className="grid gap-1 text-xs sm:grid-cols-2">
                <div>ASN：{data.network?.asn || identity.asnNumber || identity.asn || "无数据"}</div>
                <div>网络名称：{data.network?.name || identity.company || "无数据"}</div>
                <div>Prefix：{data.network?.prefix || "无数据"}</div>
                <div>RPKI：{data.network?.rpki ? (rpkiText[String(data.network.rpki)] || data.network.rpki) : "无数据"}</div>
                <div className="sm:col-span-2">
                  <div className="mb-1.5 text-muted-foreground">互联网互联 ASN：</div>
                  {neighbours.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {neighbours.map((item: any, index: number) => (
                        <div key={`${item.asn}-${index}`} className={`min-w-[78px] rounded-md border px-2 py-1 text-center leading-tight ${relationClass(item.relation, index)}`}>
                          <div className="text-[11px] font-semibold">AS{item.asn}</div>
                          <div className="max-w-[96px] truncate text-[10px] font-medium" title={item.fullName || item.name || ""}>{item.name || "未知"}</div>
                        </div>
                      ))}
                    </div>
                  ) : <span className="text-muted-foreground">无数据</span>}
                </div>
                <div className="sm:col-span-2">IXP：{ixpText}</div>
                <div>PeeringDB 交换点 / 机房：{data.network?.ixCount ?? "—"} / {data.network?.facilityCount ?? "—"}</div>
                <div>AS 邻居：{data.network?.neighbourUnique ?? "—"}（左 {data.network?.neighbourLeft ?? "—"} / 右 {data.network?.neighbourRight ?? "—"}）</div>
                <div>上游：{data.network?.upstreamCount ?? "—"}{data.network?.transitFree === true ? "（Transit-free）" : ""}</div>
                <div>Peers：{data.network?.peerCount ?? "—"}</div>
                <div className="sm:col-span-2 text-[11px] text-muted-foreground">BGP 接入统计优先参考 BGP.Tools；互联 ASN 结合 RIPEstat，IXP 名称来自 PeeringDB。</div>
              </div>
            </div>

            <div className="rounded-lg border border-blue-200/60 bg-blue-500/[0.025] p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-blue-700 dark:text-blue-300">BGP 路由拓扑</div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{bgpPrefix || "无 Prefix 数据"}</div>
                </div>
                {String(data.network?.bgpGraphPageUrl || bgpGraphQuery.data?.pageUrl || "").trim() ? (
                  <a href={String(data.network?.bgpGraphPageUrl || bgpGraphQuery.data?.pageUrl)} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition-colors hover:bg-muted">
                    BGP.Tools 查看 <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : null}
              </div>
              {(bgpGraphPath || bgpPrefix) ? (
                bgpDisplayDataUrl ? (
                  <button
                    type="button"
                    onClick={() => setBgpFullscreen(true)}
                    className="block w-full cursor-zoom-in overflow-hidden rounded-md border bg-white p-2 text-left"
                    title="点击全屏查看 BGP 拓扑"
                  >
                    <img src={bgpDisplayDataUrl} alt={`BGP 路由拓扑 ${bgpPrefix || detectedIp || ""}`} className="mx-auto h-auto min-w-[680px] max-w-none lg:min-w-0 lg:max-w-full" />
                  </button>
                ) : bgpGraphQuery.isLoading ? (
                  <div className="flex min-h-40 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
                    <Activity className="mr-2 h-4 w-4 animate-spin" />正在加载 BGP 拓扑图…
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">
                    BGP 拓扑获取失败{bgpGraphQuery.data?.error ? `：${bgpGraphQuery.data.error}` : data.network?.bgpGraphError ? `：Agent ${data.network.bgpGraphError}` : ""}
                  </div>
                )
              ) : (
                <div className="rounded-md border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">
                  当前未获得 Prefix，无法生成 BGP 拓扑图。
                </div>
              )}
              <div className="mt-2 text-[10px] text-muted-foreground">图像来自 BGP.Tools Connectivity；面板内自适应卡片宽度，点击拓扑图可全屏按矢量原图查看。</div>
            </div>
          </div>
        )}

        {bgpFullscreen && bgpDisplayDataUrl ? (
          <div
            className="fixed inset-0 z-[120] flex bg-black/90 p-3 sm:p-5"
            role="dialog"
            aria-modal="true"
            aria-label="BGP 路由拓扑全屏预览"
            onClick={() => setBgpFullscreen(false)}
          >
            <button
              type="button"
              onClick={() => setBgpFullscreen(false)}
              className="fixed right-4 top-4 z-[121] inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white transition hover:bg-black/80"
              aria-label="关闭全屏预览"
            >
              <XCircle className="h-6 w-6" />
            </button>
            <div className="m-auto max-h-full max-w-full overflow-auto rounded-lg bg-white p-3 shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <img
                src={bgpDisplayDataUrl}
                alt={`BGP 路由拓扑 ${bgpPrefix || detectedIp || ""}`}
                className="block h-auto max-w-none"
              />
            </div>
          </div>
        ) : null}

        <DialogFooter className="items-center sm:justify-between">
          <div className="text-xs text-muted-foreground">
            {current?.completedAt ? `上次完成：${new Date(current.completedAt).toLocaleString()}` : current?.updatedAt ? `更新：${new Date(current.updatedAt).toLocaleTimeString()}` : ""}
          </div>
          <div className="flex gap-2">
            {family === "ipv6" && !query.data?.host.ipv6 && !current ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><XCircle className="h-3.5 w-3.5" />当前未上报 IPv6</span> : null}
            <Button variant="outline" disabled={start.isPending || running} onClick={() => start.mutate({ hostId, family, mode: "quick" })}>快速检测</Button>
            <Button disabled={start.isPending || anyRunning} onClick={() => start.mutate({ hostId, family, mode: "full" })}>{anyRunning ? <Activity className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}{current ? "重新完整检测" : "完整检测"}{query.data?.host.ipv4 && query.data?.host.ipv6 ? " · 双栈" : ""}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
