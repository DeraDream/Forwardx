<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { parseDocument, stringify } from "yaml";
import YamlEditor from "@/components/YamlEditor/index.vue";
import EgernVisualEditor from "./components/EgernVisualEditor.vue";
import LoonVisualEditor from "./components/LoonVisualEditor.vue";
import { getTemp } from "@/api/subcription/temp";
import {
  createVisualTemplate,
  deleteVisualTemplate,
  fetchVisualTemplateSource,
  getVisualTemplate,
  listVisualTemplates,
  updateVisualTemplate,
  type VisualTemplateItem,
} from "@/api/template-manager";

type Group = Record<string, any> & {
  name: string;
  type: string;
  proxies?: string[];
};
type Legacy = { file: string; text: string };
type TemplateKind = "clash" | "egern" | "loon";
const templates = ref<VisualTemplateItem[]>([]);
const legacy = ref<Legacy[]>([]);
const createVisible = ref(false),
  editorVisible = ref(false),
  loading = ref(false),
  saving = ref(false);
const createMode = ref<"blank" | "import" | "paste" | "subscription">("blank"),
  createType = ref<TemplateKind>("clash"),
  importedFile = ref(""),
  pastedYaml = ref(""),
  subscriptionURL = ref(""),
  fetchingSubscription = ref(false),
  createFilename = ref("untitled.yaml"),
  creating = ref(false);
const selectedFile = ref(""),
  filename = ref(""),
  yamlText = ref("");
const cleanYamlText = ref("");
const root = ref<Record<string, any>>({}),
  groups = ref<Group[]>([]);
const mode = ref<"visual" | "yaml">("visual"),
  templateType = ref<TemplateKind>("clash"),
  parseError = ref(""),
  visualReady = ref(false),
  dirty = ref(false),
  syncing = ref(false);
const expandedGroups = ref<number[]>([]);
const expandedRules = ref<number[]>([]);
const disabledRules = ref<string[]>([]);
const disabledRulePositions = ref<number[]>([]);
const ruleEditorVisible = ref(false),
  editingRuleIndex = ref<number | null>(null),
  ruleTarget = ref("");
const ruleForm = reactive({
  type: "DOMAIN-SUFFIX",
  value: "",
  noResolve: false,
  raw: false,
});
const countryCodes = [
  "AD",
  "AE",
  "AF",
  "AG",
  "AI",
  "AL",
  "AM",
  "AO",
  "AQ",
  "AR",
  "AS",
  "AT",
  "AU",
  "AW",
  "AX",
  "AZ",
  "BA",
  "BB",
  "BD",
  "BE",
  "BF",
  "BG",
  "BH",
  "BI",
  "BJ",
  "BL",
  "BM",
  "BN",
  "BO",
  "BQ",
  "BR",
  "BS",
  "BT",
  "BV",
  "BW",
  "BY",
  "BZ",
  "CA",
  "CC",
  "CD",
  "CF",
  "CG",
  "CH",
  "CI",
  "CK",
  "CL",
  "CM",
  "CN",
  "CO",
  "CR",
  "CU",
  "CV",
  "CW",
  "CX",
  "CY",
  "CZ",
  "DE",
  "DJ",
  "DK",
  "DM",
  "DO",
  "DZ",
  "EC",
  "EE",
  "EG",
  "EH",
  "ER",
  "ES",
  "ET",
  "FI",
  "FJ",
  "FK",
  "FM",
  "FO",
  "FR",
  "GA",
  "GB",
  "GD",
  "GE",
  "GF",
  "GG",
  "GH",
  "GI",
  "GL",
  "GM",
  "GN",
  "GP",
  "GQ",
  "GR",
  "GS",
  "GT",
  "GU",
  "GW",
  "GY",
  "HK",
  "HM",
  "HN",
  "HR",
  "HT",
  "HU",
  "ID",
  "IE",
  "IL",
  "IM",
  "IN",
  "IO",
  "IQ",
  "IR",
  "IS",
  "IT",
  "JE",
  "JM",
  "JO",
  "JP",
  "KE",
  "KG",
  "KH",
  "KI",
  "KM",
  "KN",
  "KP",
  "KR",
  "KW",
  "KY",
  "KZ",
  "LA",
  "LB",
  "LC",
  "LI",
  "LK",
  "LR",
  "LS",
  "LT",
  "LU",
  "LV",
  "LY",
  "MA",
  "MC",
  "MD",
  "ME",
  "MF",
  "MG",
  "MH",
  "MK",
  "ML",
  "MM",
  "MN",
  "MO",
  "MP",
  "MQ",
  "MR",
  "MS",
  "MT",
  "MU",
  "MV",
  "MW",
  "MX",
  "MY",
  "MZ",
  "NA",
  "NC",
  "NE",
  "NF",
  "NG",
  "NI",
  "NL",
  "NO",
  "NP",
  "NR",
  "NU",
  "NZ",
  "OM",
  "PA",
  "PE",
  "PF",
  "PG",
  "PH",
  "PK",
  "PL",
  "PM",
  "PN",
  "PR",
  "PS",
  "PT",
  "PW",
  "PY",
  "QA",
  "RE",
  "RO",
  "RS",
  "RU",
  "RW",
  "SA",
  "SB",
  "SC",
  "SD",
  "SE",
  "SG",
  "SH",
  "SI",
  "SJ",
  "SK",
  "SL",
  "SM",
  "SN",
  "SO",
  "SR",
  "SS",
  "ST",
  "SV",
  "SX",
  "SY",
  "SZ",
  "TC",
  "TD",
  "TF",
  "TG",
  "TH",
  "TJ",
  "TK",
  "TL",
  "TM",
  "TN",
  "TO",
  "TR",
  "TT",
  "TV",
  "TW",
  "TZ",
  "UA",
  "UG",
  "UM",
  "US",
  "UY",
  "UZ",
  "VA",
  "VC",
  "VE",
  "VG",
  "VI",
  "VN",
  "VU",
  "WF",
  "WS",
  "YE",
  "YT",
  "ZA",
  "ZM",
  "ZW",
];
const regionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
const ruleTypes = [
  ["域名", "DOMAIN", "精确域名", "domain"],
  ["域名", "DOMAIN-SUFFIX", "域名及其所有子域名", "domain"],
  ["域名", "DOMAIN-KEYWORD", "域名包含关键词", "text"],
  ["域名", "DOMAIN-WILDCARD", "域名通配符（*、?）", "domain"],
  ["域名", "DOMAIN-REGEX", "域名正则表达式", "regex"],
  ["域名", "GEOSITE", "使用 geosite 域名数据库", "text"],
  ["目标 IP", "IP-CIDR", "IPv4/IPv6 CIDR IP 段", "cidr"],
  ["目标 IP", "IP-CIDR6", "IPv4/IPv6 CIDR IP 段", "cidr"],
  ["目标 IP", "IP-SUFFIX", "按目标 IP 后缀/网段匹配", "cidr"],
  ["目标 IP", "IP-ASN", "目标 IP 的 ASN", "asn"],
  ["目标 IP", "GEOIP", "目标 IP 所属国家/地区", "country"],
  ["源 IP", "SRC-IP-CIDR", "来源 IP 段", "cidr"],
  ["源 IP", "SRC-IP-SUFFIX", "来源 IP 后缀/网段", "cidr"],
  ["源 IP", "SRC-IP-ASN", "来源 IP 的 ASN", "asn"],
  ["源 IP", "SRC-GEOIP", "来源 IP 国家/地区", "country"],
  ["端口", "DST-PORT", "目标端口，可写范围", "port"],
  ["端口", "SRC-PORT", "来源端口，可写范围", "port"],
  ["入站", "IN-PORT", "流量进入 Mihomo 的端口", "port"],
  ["入站", "IN-TYPE", "入站类型，例如 HTTP、SOCKS", "text"],
  ["入站", "IN-USER", "入站认证用户名", "text"],
  ["入站", "IN-NAME", "入站名称", "text"],
  ["入站", "REMATCH-NAME", "rematch 出站写入的名称", "text"],
  ["进程", "PROCESS-NAME", "进程名 / Android 包名", "text"],
  ["进程", "PROCESS-NAME-WILDCARD", "进程名通配符", "text"],
  ["进程", "PROCESS-NAME-REGEX", "进程名正则", "regex"],
  ["进程", "PROCESS-PATH", "进程完整路径", "text"],
  ["进程", "PROCESS-PATH-WILDCARD", "进程路径通配符", "text"],
  ["进程", "PROCESS-PATH-REGEX", "进程路径正则", "regex"],
  ["进程", "UID", "Linux 用户 ID", "number"],
  ["协议", "NETWORK", "TCP 或 UDP", "network"],
  ["协议", "DSCP", "DSCP 标记", "number"],
  ["规则集", "RULE-SET", "引用 rule-providers 中的规则集", "text"],
  ["逻辑", "AND", "同时满足多个条件（高级）", "raw"],
  ["逻辑", "OR", "满足任一条件（高级）", "raw"],
  ["逻辑", "NOT", "条件取反（高级）", "raw"],
  ["逻辑", "SUB-RULE", "跳转到子规则（高级）", "raw"],
  ["兜底", "MATCH", "匹配所有剩余流量", "none"],
] as const;
const selectedRuleType = computed(
  () => ruleTypes.find((item) => item[1] === ruleForm.type) || ruleTypes[0]
);
const ruleProviderNames = computed(() => {
  const providers = root.value["rule-providers"];
  return providers && typeof providers === "object" && !Array.isArray(providers)
    ? Object.keys(providers).sort((left, right) => left.localeCompare(right))
    : [];
});
const types = [
  { value: "select", label: "手动选择" },
  { value: "url-test", label: "自动测速" },
  { value: "fallback", label: "故障转移" },
  { value: "load-balance", label: "负载均衡" },
  { value: "relay", label: "链式代理" },
];
const speedTypes = new Set(["url-test", "fallback", "load-balance"]);
const names = computed(() =>
  groups.value.map((group) => group.name).filter(Boolean)
);
const previewYaml = computed(() => {
  if (templateType.value !== "clash") return yamlText.value;
  const doc = parseDocument(yamlText.value, {
    prettyErrors: false,
    strict: true,
  });
  if (doc.errors.length) return "# YAML 格式错误，修复后会显示代理组预览";
  const value = doc.toJS();
  if (!value || Array.isArray(value) || typeof value !== "object")
    return "# 暂无代理组配置";
  return stringify(
    { "proxy-groups": value["proxy-groups"] || [] },
    { lineWidth: 0 }
  );
});
const codeModeLabel = computed(() => templateType.value === "loon" ? "配置代码" : "YAML 代码");
const previewTitle = computed(() => templateType.value === "clash" ? "代理组配置预览" : templateType.value === "egern" ? "Egern 配置预览" : "Loon 配置预览");
const blank = () => ({
  "mixed-port": 7890,
  "allow-lan": false,
  mode: "rule",
  "log-level": "info",
  "proxy-groups": [],
  rules: ["MATCH,DIRECT"],
});
const blankEgern = () => ({ policy_groups: [], rules: [{ default: { policy: "DIRECT" } }] });
const blankLoon = () => "[Proxy]\n__LOON_PROXY_ENTRIES__\n\n[Proxy Group]\n🚀 节点选择 = select,__LOON_ALL_NODES__,DIRECT\n\n[Rule]\nFINAL,🚀 节点选择\n";
function detectTemplateType(filename: string, content: string): TemplateKind {
  if (/\.conf$/i.test(filename) || /\[Proxy Group\]/i.test(content)) return "loon";
  if (/^\s*policy_groups\s*:/m.test(content)) return "egern";
  return "clash";
}
function filenameForType(name: string, kind: TemplateKind) {
  if (kind === "loon" && /\.ya?ml$/i.test(name)) return name.replace(/\.ya?ml$/i, ".conf");
  if (kind !== "loon" && /\.conf$/i.test(name)) return name.replace(/\.conf$/i, ".yaml");
  return /\.(ya?ml|conf)$/i.test(name) ? name : `${name}.${kind === "loon" ? "conf" : "yaml"}`;
}
function setCreateType(kind: string | number | boolean | undefined) {
  if (kind !== "clash" && kind !== "egern" && kind !== "loon") return;
  createType.value = kind;
  createFilename.value = filenameForType(createFilename.value, kind);
}

function reset() {
  selectedFile.value = "";
  filename.value = "untitled.yaml";
  templateType.value = createType.value;
  root.value = templateType.value === "egern" ? blankEgern() : blank();
  groups.value = [];
  disabledRules.value = [];
  disabledRulePositions.value = [];
  yamlText.value = templateType.value === "loon" ? blankLoon() : stringify(root.value, { lineWidth: 0 });
  parseError.value = "";
  visualReady.value = true;
  mode.value = "visual";
  dirty.value = false;
}
function parse(showError = true) {
  if (templateType.value === "loon") {
    const valid = /^\s*\[[^\]]+\]/m.test(yamlText.value);
    parseError.value = valid ? "" : "Loon 配置至少需要一个 INI 分段，例如 [Proxy Group]";
    visualReady.value = valid;
    if (!valid && showError) ElMessage.error(parseError.value);
    return valid;
  }
  const doc = parseDocument(yamlText.value, {
    prettyErrors: false,
    strict: true,
  });
  if (doc.errors.length) {
    parseError.value = String(doc.errors[0].message || "YAML 格式错误");
    visualReady.value = false;
    if (showError) ElMessage.error(`无法切换可视化编辑：${parseError.value}`);
    return false;
  }
  const value = doc.toJS();
  if (!value || Array.isArray(value) || typeof value !== "object") {
    parseError.value = "模板根节点必须是 YAML 对象";
    visualReady.value = false;
    if (showError) ElMessage.error(parseError.value);
    return false;
  }
  if (templateType.value === "egern") {
    if (value.policy_groups !== undefined && !Array.isArray(value.policy_groups)) {
      parseError.value = "policy_groups 必须是策略组数组";
      visualReady.value = false;
      if (showError) ElMessage.error(parseError.value);
      return false;
    }
    root.value = value;
    groups.value = [];
    parseError.value = "";
    visualReady.value = true;
    return true;
  }
  const parsedGroups = value["proxy-groups"] || [];
  if (
    !Array.isArray(parsedGroups) ||
    parsedGroups.some((item) => !item || typeof item !== "object")
  ) {
    parseError.value = "proxy-groups 必须是代理组数组";
    visualReady.value = false;
    if (showError) ElMessage.error(parseError.value);
    return false;
  }
  const marker = "# 已停用规则（打开开关可恢复）";
  const markerAt = yamlText.value.indexOf(marker);
  disabledRules.value =
    markerAt < 0
      ? []
      : yamlText.value
          .slice(markerAt + marker.length)
          .split("\n")
          .map((line) => line.match(/^\s*#\s*-\s*(.+)$/)?.[1]?.trim())
          .filter((line): line is string => Boolean(line));
  disabledRulePositions.value = disabledRules.value.map(
    () => Number.MAX_SAFE_INTEGER
  );
  syncing.value = true;
  root.value = value;
  groups.value = parsedGroups.map((item) => ({ proxies: [], ...item }));
  expandedGroups.value = [];
  expandedRules.value = [];
  syncing.value = false;
  parseError.value = "";
  visualReady.value = true;
  return true;
}
function sync() {
  if (templateType.value !== "clash" || syncing.value || !visualReady.value) return;
  root.value["proxy-groups"] = groups.value.map((group) => {
    const item = { ...group };
    delete item["include-all"];
    if (!item.proxies?.length) delete item.proxies;
    Object.keys(item).forEach((key) => {
      if (item[key] === "" || item[key] === false || item[key] === undefined)
        delete item[key];
    });
    return item;
  });
  yamlText.value = renderYaml();
  dirty.value = true;
}
watch(groups, sync, { deep: true });
watch(yamlText, () => {
  if (!syncing.value && mode.value === "yaml") dirty.value = true;
});
async function loadList() {
  const { data } = await listVisualTemplates();
  templates.value = data || [];
}
async function openCreate() {
  createMode.value = "blank";
  importedFile.value = "";
  pastedYaml.value = "";
  subscriptionURL.value = "";
  createFilename.value = "untitled.yaml";
  createType.value = "clash";
  createVisible.value = true;
  const { data } = await getTemp();
  legacy.value = (data || []).filter((item: Legacy) =>
    /\.(?:ya?ml|conf)$/i.test(item.file)
  );
}
function selectLegacy(file: string) {
  const item = legacy.value.find((candidate) => candidate.file === file);
  if (item) {
    createFilename.value = item.file;
    pastedYaml.value = item.text;
    createType.value = detectTemplateType(item.file, item.text);
  }
}
async function fetchSubscription() {
  if (!subscriptionURL.value.trim()) {
    ElMessage.warning("请输入订阅地址");
    return;
  }
  fetchingSubscription.value = true;
  try {
    const { data } = await fetchVisualTemplateSource(subscriptionURL.value);
    pastedYaml.value = data.content;
    ElMessage.success("订阅内容已拉取，请确认后继续");
  } finally {
    fetchingSubscription.value = false;
  }
}
async function create() {
  const name = createFilename.value.trim();
  if (!name) {
    ElMessage.warning("请输入模板文件名");
    return;
  }
  if (createMode.value === "import" && !importedFile.value) {
    ElMessage.warning("请选择要导入的现有模板");
    return;
  }
  const content =
    createMode.value === "blank"
      ? createType.value === "loon" ? blankLoon() : stringify(createType.value === "egern" ? blankEgern() : blank(), { lineWidth: 0 })
      : pastedYaml.value;
  if (!content.trim()) {
    ElMessage.warning(
      createMode.value === "paste" ? "请粘贴 YAML 内容" : "请先拉取订阅内容"
    );
    return;
  }
  if (createType.value !== "loon") { const doc = parseDocument(content, { prettyErrors: false, strict: true }); if (doc.errors.length) { ElMessage.error(`YAML 格式错误：${doc.errors[0].message}`); return; } }
  creating.value = true;
  try {
    await createVisualTemplate({ filename: filenameForType(name, createType.value), content, type: createType.value });
    await loadList();
    createVisible.value = false;
    ElMessage.success("模板已创建，请从列表点击编辑");
  } finally {
    creating.value = false;
  }
}
async function edit(file: string) {
  loading.value = true;
  try {
    const { data } = await getVisualTemplate(file);
    selectedFile.value = data.file;
    filename.value = data.file;
    yamlText.value = data.content;
    templateType.value = data.type || detectTemplateType(data.file, data.content);
    parse(false);
    mode.value = visualReady.value ? "visual" : "yaml";
    dirty.value = false;
    editorVisible.value = true;
    await nextTick();
    await nextTick();
    cleanYamlText.value = yamlText.value;
    dirty.value = false;
  } finally {
    loading.value = false;
  }
}
function addGroup() {
  groups.value.push({
    name: `新代理组 ${groups.value.length + 1}`,
    type: "select",
    proxies: ["DIRECT"],
  });
}
function move(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= groups.value.length) return;
  const [item] = groups.value.splice(index, 1);
  groups.value.splice(target, 0, item);
}
function isExpanded(index: number) {
  return expandedGroups.value.includes(index);
}
function toggleGroup(index: number) {
  expandedGroups.value = isExpanded(index)
    ? expandedGroups.value.filter((item) => item !== index)
    : [...expandedGroups.value, index];
}
function toggleRules(index: number) {
  expandedRules.value = expandedRules.value.includes(index)
    ? expandedRules.value.filter((item) => item !== index)
    : [...expandedRules.value, index];
}
function splitRule(line: string) {
  const out: string[] = [],
    buf: string[] = [];
  let depth = 0;
  for (const char of line) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      out.push(buf.join("").trim());
      buf.length = 0;
    } else buf.push(char);
  }
  out.push(buf.join("").trim());
  return out;
}
function ruleTargetOf(line: string) {
  const parts = splitRule(line);
  if (parts[0] === "MATCH") return parts[1] || "";
  for (let i = parts.length - 1; i > 0; i--)
    if (!["no-resolve", "src"].includes(parts[i])) return parts[i];
  return "";
}
function allRules() {
  return Array.isArray(root.value.rules) ? root.value.rules.map(String) : [];
}
function renderYaml() {
  const content = stringify(root.value, { lineWidth: 0 });
  return disabledRules.value.length
    ? `${content.trimEnd()}\n\n# 已停用规则（打开开关可恢复）\n${disabledRules.value.map((rule) => `# - ${rule}`).join("\n")}\n`
    : content;
}
function rulesForTarget(target: string) {
  const activePosition = (index: number) => {
    let position = index;
    while (disabledRulePositions.value.includes(position)) position++;
    return position;
  };
  const active = allRules()
    .map((line, index) => ({
      line,
      index,
      order: activePosition(index),
      disabled: false,
      type: splitRule(line)[0],
      value: splitRule(line)[1] || "",
    }))
    .filter((rule) => ruleTargetOf(rule.line) === target);
  return [
    ...active,
    ...disabledRules.value
      .map((line, index) => ({
        line,
        index: -index - 1,
        order: disabledRulePositions.value[index],
        disabled: true,
        type: splitRule(line)[0],
        value: splitRule(line)[1] || "",
      }))
      .filter((rule) => ruleTargetOf(rule.line) === target),
  ].sort((left, right) => left.order - right.order);
}
function ruleDescription(type: string) {
  return ruleTypes.find((item) => item[1] === type)?.[2] || "高级规则";
}
function syncRules(rules: string[]) {
  root.value.rules = rules;
  syncing.value = true;
  yamlText.value = renderYaml();
  syncing.value = false;
  dirty.value = true;
}
function openRule(target: string, index: number | null = null) {
  ruleTarget.value = target;
  editingRuleIndex.value = index;
  const line =
    index === null
      ? ""
      : index >= 0
        ? allRules()[index]
        : disabledRules.value[-index - 1];
  const parts = splitRule(line);
  ruleForm.type = parts[0] || "DOMAIN-SUFFIX";
  ruleForm.value = parts[1] || "";
  ruleForm.noResolve = parts.includes("no-resolve");
  ruleForm.raw = ["AND", "OR", "NOT", "SUB-RULE"].includes(ruleForm.type);
  ruleEditorVisible.value = true;
}
function validateRule() {
  const kind = selectedRuleType.value[3];
  const value = ruleForm.value.trim();
  if (kind === "none") return true;
  if (!value) return "请输入匹配内容";
  if (ruleForm.type === "RULE-SET" && !ruleProviderNames.value.includes(value))
    return "请选择当前模板 rule-providers 中已有的规则集";
  if (kind === "cidr") {
    const [address, bits] = value.split("/");
    const isV4 =
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) &&
      address
        .split(".")
        .every((item) => Number(item) >= 0 && Number(item) <= 255);
    const isV6 = /^[0-9a-fA-F:]+$/.test(address) && address.includes(":");
    const maximum = isV4 ? 32 : isV6 ? 128 : 0;
    if (
      !maximum ||
      !/^\d+$/.test(bits) ||
      Number(bits) < 0 ||
      Number(bits) > maximum
    )
      return "请输入合法 CIDR，例如 1.2.3.0/24 或 2001:db8::/32";
  }
  if (kind === "port") {
    const ranges = value.split(/[\/,]/);
    const valid =
      ranges.length &&
      ranges.every((range) => {
        const values = range.split("-").map(Number);
        return (
          values.length <= 2 &&
          values.every(
            (port) => Number.isInteger(port) && port >= 1 && port <= 65535
          ) &&
          (values.length < 2 || values[0] <= values[1])
        );
      });
    if (!valid) return "端口必须为 1-65535，可填写 80、80-443 或 80/443";
  }
  if (kind === "asn" && !/^\d+$/.test(value)) return "ASN 必须是数字";
  if (kind === "number" && !/^\d+$/.test(value)) return "请输入数字";
  if (kind === "domain" && !/^[*?a-zA-Z0-9.-]+$/.test(value))
    return "域名只能包含字母、数字、点、连字符和通配符";
  if (kind === "network" && !/^(tcp|udp)$/i.test(value))
    return "仅支持 tcp 或 udp";
  return true;
}
function saveRule() {
  const valid = validateRule();
  if (valid !== true) {
    ElMessage.error(valid);
    return;
  }
  const type = ruleForm.type,
    value = ruleForm.value.trim();
  const line =
    type === "MATCH"
      ? `MATCH,${ruleTarget.value}`
      : `${type},${value},${ruleTarget.value}${ruleForm.noResolve ? ",no-resolve" : ""}`;
  const rules = allRules();
  if (editingRuleIndex.value === null) rules.push(line);
  else if (editingRuleIndex.value >= 0) rules[editingRuleIndex.value] = line;
  else disabledRules.value.splice(-editingRuleIndex.value - 1, 1, line);
  syncRules(rules);
  ruleEditorVisible.value = false;
}
function deleteRule(index: number) {
  const rules = allRules();
  if (index >= 0) rules.splice(index, 1);
  else {
    disabledRules.value.splice(-index - 1, 1);
    disabledRulePositions.value.splice(-index - 1, 1);
  }
  syncRules(rules);
}
function toggleRule(index: number, enabled: boolean) {
  const rules = allRules();
  if (enabled && index < 0) {
    const disabledIndex = -index - 1;
    const position = disabledRulePositions.value.splice(disabledIndex, 1)[0];
    const line = disabledRules.value.splice(disabledIndex, 1)[0];
    const insertAt = rules.findIndex((_, activeIndex) => {
      let order = activeIndex;
      while (disabledRulePositions.value.includes(order)) order++;
      return order > position;
    });
    rules.splice(insertAt < 0 ? rules.length : insertAt, 0, line);
  }
  if (!enabled && index >= 0) {
    disabledRules.value.push(rules.splice(index, 1)[0]);
    disabledRulePositions.value.push(
      index +
        disabledRulePositions.value.filter((position) => position <= index)
          .length
    );
  }
  syncRules(rules);
}
function switchMode(value: string | number | boolean | undefined) {
  if (value !== "visual" && value !== "yaml") return;
  if (value === "visual" && !parse()) return;
  mode.value = value;
}
function onExternalVisualChange() { dirty.value = true; }
async function copyPreview() {
  try {
    await navigator.clipboard.writeText(previewYaml.value);
    ElMessage.success("代理组配置已复制");
  } catch {
    ElMessage.error("复制失败，请检查浏览器剪贴板权限");
  }
}
function refreshPreview() {
  if (parse(false)) ElMessage.success("预览已刷新");
  else ElMessage.error(`YAML 格式错误：${parseError.value}`);
}
async function save() {
  const name = filename.value.trim();
  if (!name) {
    ElMessage.warning("请输入模板文件名");
    return;
  }
  if (mode.value === "yaml" && !parse(false)) {
    ElMessage.error(`YAML 格式错误：${parseError.value}`);
    return;
  }
  const groupNames = groups.value
    .map((item) => item.name.trim())
    .filter(Boolean);
  if (templateType.value === "clash" && (
    groupNames.length !== groups.value.length ||
    new Set(groupNames).size !== groupNames.length
  )) {
    ElMessage.error("每个代理组都需要唯一的名称");
    return;
  }
  saving.value = true;
  try {
    if (selectedFile.value)
      await updateVisualTemplate({
        filename: filenameForType(name, templateType.value),
        old_name: selectedFile.value,
        content: yamlText.value,
        type: templateType.value,
      });
    else
      await createVisualTemplate({ filename: filenameForType(name, templateType.value), content: yamlText.value, type: templateType.value });
    selectedFile.value = filenameForType(name, templateType.value);
    filename.value = selectedFile.value;
    cleanYamlText.value = yamlText.value;
    dirty.value = false;
    await loadList();
    ElMessage.success("模板已保存");
  } finally {
    saving.value = false;
  }
}
async function close(done?: () => void) {
  if (!dirty.value || yamlText.value === cleanYamlText.value) {
    editorVisible.value = false;
    done?.();
    return;
  }
  try {
    await ElMessageBox.confirm(
      "当前模板有未保存的更改，确定关闭吗？",
      "未保存的更改",
      { type: "warning" }
    );
    editorVisible.value = false;
    done?.();
  } catch {}
}
function requestClose() {
  return close();
}
async function remove(file: string) {
  try {
    await ElMessageBox.confirm(`确定删除模板「${file}」吗？`, "删除模板", {
      type: "warning",
    });
    await deleteVisualTemplate(file);
    await loadList();
    ElMessage.success("模板已删除");
  } catch (error: any) {
    if (error !== "cancel" && error !== "close") throw error;
  }
}
loadList();
</script>

<template>
  <div class="template-manager page-workspace">
    <header class="page-heading">
      <div>
        <h1>模板管理</h1>
        <p>创建或导入 Clash/Mihomo、Egern、Loon 模板，再进入各自独立的可视化编辑器。</p>
      </div>
      <el-button type="primary" @click="openCreate">新建模板</el-button>
    </header>
    <section class="work-surface manager-list" v-loading="loading">
      <el-table :data="templates" empty-text="暂无模板，点击右上角新建模板"
        ><el-table-column prop="file" label="模板名称" min-width="360"
          ><template #default="{ row }"
            ><strong>{{ row.file }}</strong><el-tag size="small" class="template-kind">{{ row.type === "egern" ? "Egern" : row.type === "loon" ? "Loon" : "Clash / Mihomo" }}</el-tag></template
          ></el-table-column
        ><el-table-column
          prop="updated_at"
          label="更新时间"
          min-width="220"
        /><el-table-column label="操作" width="180" align="right"
          ><template #default="{ row }"
            ><el-button link type="primary" @click="edit(row.file)"
              >编辑</el-button
            ><el-button link type="danger" @click="remove(row.file)"
              >删除</el-button
            ></template
          ></el-table-column
        ></el-table
      >
    </section>

    <el-dialog
      v-model="createVisible"
      title="创建模板"
      width="min(680px, 94vw)"
      destroy-on-close
    >
      <p class="intro">
        创建或导入 Clash/Mihomo、Egern、Loon 模板。
      </p>
      <el-form label-position="top"
        ><el-form-item label="模板文件名"
          ><el-input
            v-model="createFilename"
            placeholder="例如 my-template.yaml" /></el-form-item
      ></el-form>
      <el-radio-group v-model="createMode" class="create-tabs"
        ><el-radio-button value="blank">创建空白模板</el-radio-button
        ><el-radio-button value="import">从模板列表导入</el-radio-button
        ><el-radio-button value="paste">粘贴代码</el-radio-button
        ><el-radio-button value="subscription"
          >从订阅导入</el-radio-button
        ></el-radio-group
      >
      <div v-if="createMode === 'blank'" class="create-option">
        <el-form label-position="top"><el-form-item label="模板类型"><el-radio-group :model-value="createType" @change="setCreateType"><el-radio-button value="clash">Clash / Mihomo</el-radio-button><el-radio-button value="egern">Egern</el-radio-button><el-radio-button value="loon">Loon</el-radio-button></el-radio-group></el-form-item></el-form>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          :title="createType === 'loon' ? '会创建基础 Loon .conf（INI）配置。' : createType === 'egern' ? '会创建基础 Egern YAML；之后可编辑策略组和规则。' : '会创建基础 Clash/Mihomo YAML；之后可在可视化编辑器添加代理组。'"
        />
      </div>
      <div v-else-if="createMode === 'import'" class="create-option">
        <el-form label-position="top"
          ><el-form-item label="选择现有模板"
            ><el-select
              v-model="importedFile"
              filterable
              placeholder="选择要导入的模板"
              class="wide"
              @change="selectLegacy"
              ><el-option
                v-for="item in legacy"
                :key="item.file"
                :label="item.file"
                :value="item.file" /></el-select></el-form-item></el-form
        ><el-alert
          type="warning"
          :closable="false"
          show-icon
          title="支持 YAML 和 Loon CONF 模板。类型会根据导入内容自动识别；导入后另存为可视化模板，不会修改原模板。"
        />
      </div>
      <div v-else-if="createMode === 'paste'" class="create-option">
        <el-form label-position="top"
          ><el-form-item label="模板类型"><el-radio-group :model-value="createType" @change="setCreateType"><el-radio-button value="clash">Clash / Mihomo</el-radio-button><el-radio-button value="egern">Egern</el-radio-button><el-radio-button value="loon">Loon</el-radio-button></el-radio-group></el-form-item
          ><el-form-item :label="createType === 'loon' ? '粘贴 Loon CONF 内容' : '粘贴 YAML 内容'"
            ><el-input
              v-model="pastedYaml"
              type="textarea"
              :rows="7"
              :placeholder="createType === 'loon' ? '粘贴 Loon INI / CONF 配置' : createType === 'egern' ? '粘贴 Egern YAML 配置' : '粘贴 Clash / Mihomo YAML 配置'" /></el-form-item
        ></el-form>
      </div>
      <div v-else class="create-option">
        <el-form label-position="top"
          ><el-form-item label="模板类型"><el-radio-group :model-value="createType" @change="setCreateType"><el-radio-button value="clash">Clash / Mihomo</el-radio-button><el-radio-button value="egern">Egern</el-radio-button><el-radio-button value="loon">Loon</el-radio-button></el-radio-group></el-form-item
          ><el-form-item label="订阅地址"
            ><div class="subscription-input">
              <el-input
                v-model="subscriptionURL"
                placeholder="https://example.com/config.yaml"
              /><el-button
                :loading="fetchingSubscription"
                @click="fetchSubscription"
                >拉取</el-button
              >
            </div></el-form-item
          ><el-form-item label="拉取结果"
            ><el-input
              v-model="pastedYaml"
              type="textarea"
              :rows="5"
              placeholder="拉取成功后会显示在这里，也可直接修改" /></el-form-item></el-form
        ><el-alert
          type="warning"
          :closable="false"
          show-icon
          title="支持直接返回所选模板类型的 HTTP(S) 地址；本地和私有网络地址会被拒绝。"
        />
      </div>
      <template #footer
        ><el-button @click="createVisible = false">取消</el-button
        ><el-button type="primary" :loading="creating" @click="create"
          >创建</el-button
        ></template
      >
    </el-dialog>

    <el-dialog
      v-model="editorVisible"
      class="editor-dialog"
      width="calc(100vw - 48px)"
      top="24px"
      :close-on-click-modal="false"
      destroy-on-close
      :before-close="close"
    >
      <template #header
        ><div class="editor-title">
          <div>
            <h2>{{ selectedFile || filename || "新模板" }}</h2>
            <p>编辑模板配置</p>
          </div>
          <div class="actions">
            <el-button type="primary" :loading="saving" @click="save"
              >保存</el-button
            ><el-button @click="requestClose">关闭</el-button>
          </div>
        </div></template
      >
      <div class="toolbar">
        <el-input
          v-model="filename"
          class="filename"
          placeholder="模板文件名，例如 my-template.yaml"
          ><template #prepend>文件名</template></el-input
        >
      </div>
      <el-alert
        v-if="parseError"
        type="warning"
        :closable="false"
        show-icon
        class="parse-error"
        :title="`可视化编辑不可用：${parseError}`"
      />
      <div class="editor-layout">
        <section class="panel editor-panel">
          <div class="editor-tabs">
            <el-radio-group :model-value="mode" @change="switchMode"
              ><el-radio-button value="visual">可视化编辑</el-radio-button
              ><el-radio-button value="yaml"
                >{{ codeModeLabel }}</el-radio-button
              ></el-radio-group
            >
          </div>
          <template v-if="mode === 'visual' && visualReady && templateType === 'clash'"
            ><div class="panel-title">
              <span
                >代理组配置 <em>{{ groups.length }}</em></span
              ><el-button size="small" type="primary" @click="addGroup"
                >添加代理组</el-button
              >
            </div>
            <el-scrollbar class="scroll"
              ><div class="groups">
                <el-empty
                  v-if="!groups.length"
                  description="暂无代理组"
                  :image-size="72"
                />
                <article
                  v-for="(group, index) in groups"
                  :key="index"
                  class="group"
                  :class="{ expanded: isExpanded(index) }"
                >
                  <div class="group-head">
                    <button
                      class="group-toggle"
                      :aria-label="
                        isExpanded(index) ? '收起代理组' : '展开代理组'
                      "
                      @click="toggleGroup(index)"
                    >
                      <span class="drag">⠿</span
                      ><strong>{{
                        group.name || `未命名代理组 ${index + 1}`
                      }}</strong
                      ><small>{{
                        types.find((item) => item.value === group.type)
                          ?.label || group.type
                      }}</small
                      ><span class="chevron" aria-hidden="true" />
                    </button>
                    <div class="group-actions">
                      <el-button
                        circle
                        size="small"
                        :disabled="index === 0"
                        @click="move(index, -1)"
                        >↑</el-button
                      ><el-button
                        circle
                        size="small"
                        :disabled="index === groups.length - 1"
                        @click="move(index, 1)"
                        >↓</el-button
                      ><el-button
                        circle
                        size="small"
                        type="danger"
                        plain
                        @click="groups.splice(index, 1)"
                        >×</el-button
                      >
                    </div>
                  </div>
                  <transition name="group-expand"
                    ><div v-if="isExpanded(index)" class="fields">
                      <div class="field-grid">
                        <label
                          >组名称<el-input
                            v-model="group.name"
                            placeholder="例如：🚀 手动选择" /></label
                        ><label
                          >组类型<el-select v-model="group.type"
                            ><el-option
                              v-for="item in types"
                              :key="item.value"
                              :label="item.label"
                              :value="item.value" /></el-select
                        ></label>
                      </div>
                      <div class="switches">
                        <el-switch
                          v-model="group.hidden"
                          active-text="在客户端隐藏"
                        />
                      </div>
                      <div v-if="speedTypes.has(group.type)" class="speed">
                        <label
                          >测试 URL<el-input
                            v-model="group.url"
                            placeholder="https://www.gstatic.com/generate_204" /></label
                        ><label
                          >测速间隔<el-input-number
                            v-model="group.interval"
                            :min="1"
                            placeholder="300" /></label
                        ><label
                          >容差<el-input-number
                            v-model="group.tolerance"
                            :min="0"
                            placeholder="50"
                        /></label>
                      </div>
                      <div class="field-grid">
                        <label
                          >筛选关键词（filter）<el-input
                            v-model="group.filter"
                            placeholder="例如：香港|HK"
                            clearable /></label
                        ><label
                          >排除关键词（exclude-filter）<el-input
                            v-model="group['exclude-filter']"
                            placeholder="例如：游戏|IPLC"
                            clearable
                        /></label>
                      </div>
                      <div class="proxies">
                        <label>代理组成员</label>
                        <div
                          v-for="(_, proxyIndex) in group.proxies || []"
                          :key="proxyIndex"
                          class="proxy"
                        >
                          <el-select
                            v-model="group.proxies![proxyIndex]"
                            filterable
                            allow-create
                            default-first-option
                            placeholder="选择组或输入成员"
                            ><el-option
                              value="DIRECT"
                              label="DIRECT" /><el-option
                              value="REJECT"
                              label="REJECT" /><el-option
                              v-for="name in names.filter(
                                (name) => name !== group.name
                              )"
                              :key="name"
                              :value="name"
                              :label="name" /></el-select
                          ><el-button
                            type="danger"
                            link
                            @click="group.proxies?.splice(proxyIndex, 1)"
                            >移除</el-button
                          >
                        </div>
                        <el-button
                          size="small"
                          plain
                          @click="(group.proxies ||= []).push('')"
                          >添加成员</el-button
                        >
                      </div>
                      <div class="rules-block">
                        <button
                          class="rules-toggle"
                          @click="toggleRules(index)"
                        >
                          <span
                            >流量规则（{{
                              rulesForTarget(group.name).length
                            }}）</span
                          >
                          <small>{{
                            expandedRules.includes(index) ? "收起" : "展开"
                          }}</small>
                        </button>
                        <transition name="group-expand">
                          <div
                            v-if="expandedRules.includes(index)"
                            class="rules-list"
                          >
                            <el-button
                              size="small"
                              type="primary"
                              plain
                              @click="openRule(group.name)"
                              >添加规则</el-button
                            >
                            <div
                              v-if="!rulesForTarget(group.name).length"
                              class="rules-empty"
                            >
                              暂无引用此代理组的规则
                            </div>
                            <div
                              v-for="rule in rulesForTarget(group.name)"
                              :key="rule.index"
                              class="rule-row"
                            >
                              <div>
                                <small
                                  >{{ rule.type }}（{{
                                    ruleDescription(rule.type)
                                  }}）</small
                                ><strong>{{
                                  rule.value || "匹配所有剩余流量"
                                }}</strong
                                ><code>{{ rule.line }}</code>
                              </div>
                              <span
                                ><el-switch
                                  :model-value="!rule.disabled"
                                  size="small"
                                  @change="
                                    toggleRule(rule.index, Boolean($event))
                                  "
                                />
                                <el-button
                                  link
                                  @click="openRule(group.name, rule.index)"
                                  >编辑</el-button
                                ><el-button
                                  link
                                  type="danger"
                                  @click="deleteRule(rule.index)"
                                  >删除</el-button
                                ></span
                              >
                            </div>
                          </div>
                        </transition>
                      </div>
                    </div></transition
                  >
                </article>
              </div></el-scrollbar
            ></template
          ><template v-else-if="mode === 'visual' && visualReady && templateType === 'egern'"
            ><EgernVisualEditor v-model="yamlText" @update:model-value="onExternalVisualChange" @error="parseError = $event" /></template
          ><template v-else-if="mode === 'visual' && visualReady && templateType === 'loon'"
            ><LoonVisualEditor v-model="yamlText" @update:model-value="onExternalVisualChange" @error="parseError = $event" /></template
          ><template v-else
            ><div class="panel-title">{{ codeModeLabel }}</div>
            <YamlEditor
              v-model="yamlText"
              :language="templateType === 'loon' ? 'ini' : 'yaml'"
          /></template>
        </section>
        <section class="panel preview">
          <div class="panel-title">
            <span>{{ previewTitle }}</span>
            <div class="preview-actions">
              <el-button link title="复制预览" @click="copyPreview"
                >复制</el-button
              ><el-button link title="刷新预览" @click="refreshPreview"
                >刷新</el-button
              >
            </div>
          </div>
          <pre>{{ previewYaml }}</pre>
        </section>
      </div>
    </el-dialog>
    <el-dialog
      v-model="ruleEditorVisible"
      :title="editingRuleIndex === null ? '添加流量规则' : '编辑流量规则'"
      width="min(600px, 94vw)"
      append-to-body
    >
      <el-form label-position="top"
        ><el-form-item label="规则类型"
          ><el-select
            v-model="ruleForm.type"
            filterable
            @change="
              ruleForm.value = '';
              ruleForm.noResolve = false;
            "
            ><el-option-group
              v-for="category in [...new Set(ruleTypes.map((item) => item[0]))]"
              :key="category"
              :label="category"
              ><el-option
                v-for="item in ruleTypes.filter((item) => item[0] === category)"
                :key="item[1]"
                :value="item[1]"
                :label="item[2]" /></el-option-group></el-select></el-form-item
        ><el-form-item
          v-if="selectedRuleType[3] !== 'none'"
          :label="selectedRuleType[2]"
          ><el-select
            v-if="ruleForm.type === 'RULE-SET'"
            v-model="ruleForm.value"
            filterable
            placeholder="选择当前模板的规则集"
            no-data-text="当前模板未定义 rule-providers"
            ><el-option
              v-for="name in ruleProviderNames"
              :key="name"
              :value="name"
              :label="name" /></el-select
          ><el-select
            v-else-if="selectedRuleType[3] === 'country'"
            v-model="ruleForm.value"
            filterable
            placeholder="选择国家/地区"
            ><el-option
              v-for="code in countryCodes"
              :key="code"
              :value="code"
              :label="regionNames.of(code) + '（' + code + '）'" /></el-select
          ><el-select
            v-else-if="selectedRuleType[3] === 'network'"
            v-model="ruleForm.value"
            ><el-option label="TCP" value="tcp" /><el-option
              label="UDP"
              value="udp" /></el-select
          ><el-input
            v-else
            v-model="ruleForm.value"
            :placeholder="
              selectedRuleType[3] === 'cidr'
                ? '例如 1.2.3.0/24'
                : selectedRuleType[3] === 'port'
                  ? '例如 80、80-443 或 80/443'
                  : '请输入匹配内容'
            " /></el-form-item
        ><el-form-item
          v-if="
            ['IP-CIDR', 'IP-CIDR6', 'IP-SUFFIX', 'IP-ASN', 'GEOIP'].includes(
              ruleForm.type
            )
          "
          ><el-switch
            v-model="ruleForm.noResolve"
            active-text="不解析域名（no-resolve）" /></el-form-item
        ><el-alert
          type="info"
          :closable="false"
          :title="`将生成：${ruleForm.type}${selectedRuleType[3] === 'none' ? '' : ',' + (ruleForm.value || '匹配内容')},${ruleTarget}${ruleForm.noResolve ? ',no-resolve' : ''}`" /></el-form
      ><template #footer
        ><el-button @click="ruleEditorVisible = false">取消</el-button
        ><el-button type="primary" @click="saveRule"
          >保存规则</el-button
        ></template
      >
    </el-dialog>
  </div>
</template>

<style scoped>
.manager-list {
  /* Let the surface follow the table's actual rows instead of reserving a
     dashboard-sized empty panel when only one template exists. */
  min-height: 0;
}
.intro {
  margin: 0 0 16px;
  color: var(--el-text-color-secondary);
}
.create-tabs {
  margin-bottom: 18px;
}
.create-option {
  min-height: 120px;
}
.wide {
  width: 100%;
}
.subscription-input {
  display: flex;
  width: 100%;
  gap: 10px;
}
.subscription-input .el-input {
  flex: 1;
}
.editor-title,
.actions,
.toolbar,
.group-head,
.switches,
.proxy,
.preview-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.editor-title {
  justify-content: space-between;
  padding-right: 32px;
}
.editor-title h2 {
  margin: 0;
  font-size: 19px;
}
.editor-title p {
  margin: 4px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.toolbar {
  padding-bottom: 14px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.filename {
  max-width: 440px;
}
.parse-error {
  margin: 14px 0;
}
.editor-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 18px;
  min-height: 0;
  flex: 1;
}
.panel {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  background: var(--el-bg-color);
}
.editor-tabs {
  padding: 0;
  background: var(--el-fill-color-light);
}
.editor-tabs :deep(.el-radio-group) {
  display: grid;
  width: 100%;
  grid-template-columns: 1fr 1fr;
}
.editor-tabs :deep(.el-radio-button__inner) {
  width: 100%;
  height: 44px;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent;
  box-shadow: none !important;
  font-size: 15px;
  font-weight: 700;
  line-height: 42px;
}
.editor-tabs
  :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  color: var(--el-color-primary);
  background: var(--el-bg-color);
  box-shadow: inset 0 -3px 0 var(--el-color-primary) !important;
}
.panel-title {
  display: flex;
  min-height: 52px;
  align-items: center;
  justify-content: space-between;
  padding: 0 18px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
  font-size: 15px;
  font-weight: 700;
}
.panel-title em {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  margin-left: 5px;
  border-radius: 10px;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  font-size: 12px;
  font-style: normal;
}
.scroll {
  min-height: 0;
  flex: 1;
}
.groups {
  display: grid;
  gap: 12px;
  padding: 14px;
}
.group {
  overflow: hidden;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  transition:
    border-color 0.22s ease,
    box-shadow 0.22s ease;
}
.group.expanded {
  border-color: var(--el-color-primary-light-5);
  box-shadow: 0 5px 16px rgb(0 0 0 / 4%);
}
.group-head {
  justify-content: space-between;
  min-height: 54px;
  padding: 0 11px;
  background: var(--el-fill-color-light);
}
.group-toggle {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 9px;
  padding: 0;
  border: 0;
  color: var(--el-text-color-primary);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.group-toggle strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
}
.group-toggle small {
  flex: none;
  padding: 3px 6px;
  border-radius: 2px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
  font-size: 11px;
}
.drag {
  color: var(--el-text-color-placeholder);
  font-size: 19px;
  letter-spacing: -3px;
}
.chevron {
  width: 8px;
  height: 8px;
  flex: none;
  margin: 0 7px 4px auto;
  border-right: 2px solid var(--el-text-color-secondary);
  border-bottom: 2px solid var(--el-text-color-secondary);
  transform: rotate(45deg);
  transition:
    transform 0.24s cubic-bezier(0.2, 0.8, 0.2, 1),
    border-color 0.2s;
}
.group-toggle:hover .chevron {
  border-color: var(--el-color-primary);
}
.expanded .chevron {
  transform: rotate(225deg);
  margin-top: 5px;
  margin-bottom: 0;
}
.group-actions {
  display: flex;
  gap: 5px;
  flex: none;
}
.fields {
  display: grid;
  gap: 16px;
  padding: 16px;
  background: var(--el-bg-color);
}
.group-expand-enter-active,
.group-expand-leave-active {
  overflow: hidden;
  transition:
    max-height 0.3s cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 0.2s ease,
    padding 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.group-expand-enter-from,
.group-expand-leave-to {
  max-height: 0;
  opacity: 0;
  padding-top: 0;
  padding-bottom: 0;
}
.group-expand-enter-to,
.group-expand-leave-from {
  max-height: 900px;
  opacity: 1;
}
.fields label,
.proxies > label {
  display: grid;
  gap: 7px;
  color: var(--el-text-color-regular);
  font-size: 13px;
  font-weight: 650;
}
.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.field-grid :deep(.el-select),
.speed :deep(.el-input-number) {
  width: 100%;
}
.switches {
  gap: 20px;
  padding: 2px 0;
}
.switches :deep(.el-switch) {
  --el-switch-on-color: var(--el-color-primary);
  height: 26px;
}
.switches :deep(.el-switch__core) {
  min-width: 48px;
  height: 26px;
  border-radius: 14px;
}
.switches :deep(.el-switch__action) {
  width: 20px;
  height: 20px;
}
.speed {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 120px 120px;
  gap: 14px;
}
.proxies {
  display: grid;
  gap: 8px;
  padding-top: 2px;
}
.proxy .el-select {
  min-width: 0;
  flex: 1;
}
.fields :deep(.el-input__wrapper),
.fields :deep(.el-select__wrapper),
.fields :deep(.el-input-number .el-input__wrapper) {
  min-height: 40px;
}
.preview pre {
  min-height: 0;
  flex: 1;
  overflow: auto;
  box-sizing: border-box;
  margin: 0;
  padding: 16px;
  color: var(--el-text-color-primary);
  font:
    12px/1.6 Consolas,
    monospace;
  white-space: pre;
}
.editor-panel :deep(.yaml-editor) {
  min-height: 0;
  flex: 1;
}
.rules-block {
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 4px;
}
.rules-toggle {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
  border: 0;
  color: var(--el-text-color-primary);
  background: transparent;
  font-weight: 700;
  cursor: pointer;
}
.rules-toggle small {
  color: var(--el-color-primary);
  font-weight: 500;
}
.rules-list {
  display: grid;
  gap: 8px;
  padding: 0 0 6px;
}
.rules-empty {
  padding: 10px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.rule-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
}
.rule-row > div {
  display: grid;
  min-width: 0;
  gap: 3px;
}
.rule-row small {
  color: var(--el-color-primary);
  font-weight: 700;
}
.rule-row strong {
  font-size: 13px;
}
.rule-row code {
  overflow: hidden;
  color: var(--el-text-color-secondary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rule-row > span {
  display: flex;
  flex: none;
}
@media (min-width: 901px) {
  :global(.editor-dialog) {
    /* The overlay already owns the 24px viewport gutter.  Keep the dialog
       inside that box, otherwise header/body heights are added to `height`. */
    display: flex;
    box-sizing: border-box;
    height: calc(100dvh - 48px);
    min-height: 0;
    flex-direction: column;
    margin: 0 auto !important;
  }
  :global(.editor-dialog .el-dialog__header) {
    flex: none;
  }
  :global(.editor-dialog .el-dialog__body) {
    display: flex;
    box-sizing: border-box;
    /* The application-wide dialog rule caps bodies at 680px.  This editor is
       intentionally viewport-sized, so that cap would leave a blank lower half. */
    max-height: none;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    padding: 0 24px 24px;
    overflow: hidden;
  }
}
@media (max-width: 900px) {
  .editor-title,
  .toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .actions {
    justify-content: flex-end;
  }
  .filename {
    max-width: none;
  }
  .editor-layout {
    grid-template-columns: 1fr;
    min-height: 0;
    flex: none;
  }
  .panel {
    min-height: 420px;
  }
  .field-grid,
  .speed {
    grid-template-columns: 1fr;
  }
  .subscription-input {
    flex-direction: column;
  }
  :global(.editor-dialog) {
    width: min(96vw, 720px) !important;
  }
  .editor-title {
    padding-right: 28px;
  }
}
</style>
