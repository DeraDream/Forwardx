<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  getSubs,
  AddSub,
  DelSub,
  UpdateSub,
  ResetSubToken,
  SetSubRevoked,
  PreviewSub,
} from "@/api/subcription/subs";
import { getTemp } from "@/api/subcription/temp";
import { getVisualTemplate, listVisualTemplates, type VisualTemplateItem } from "@/api/template-manager";
import { getNodes, setNodeDisabled } from "@/api/subcription/node";
import { beijingTimestamp, formatBeijingTime } from "@/utils/time";
import { useDraggableTableRows } from "@/utils/table-drag";
import { useAppStore } from "@/store";
import { DeviceEnum } from "@/enums/DeviceEnum";
import QrcodeVue from "qrcode.vue";
import { VueDraggable } from "vue-draggable-plus";
import TemplateSourcePicker from "./components/TemplateSourcePicker.vue";

interface Sub {
  ID: number;
  Name: string;
  CreateDate?: string;
  CreatedAt?: string;
  Config: Config | string;
  Nodes: Node[];
  SubLogs: SubLogs[];
  Token: string;
  Revoked: boolean;
  ExpireAt?: string;
  AccessLimit: number;
  AccessCount: number;
}

interface Node {
  ID: number;
  Name: string;
  Link: string;
  Disabled?: boolean;
  CreateDate?: string;
}

interface Config {
  output_type?: SubscriptionOutputType;
  clash: string;
  surge: string;
  egern: string;
  loon: string;
  egern_update_interval?: number;
  udp: boolean | string;
  cert: boolean | string;
  group_nodes?: Record<string, PolicyGroupNodeRule>;
  group_nodes_template?: string;
}

type SubscriptionOutputType = "clash" | "surge" | "egern" | "loon";

interface PolicyGroupNodeRule {
  mode: "all" | "include" | "none";
  nodes?: string[];
}

interface SubLogs {
  ip?: string;
  IP?: string;
  Count?: number;
  Addr?: string;
  Date?: string;
  date?: string;
  name?: string;
  count?: number;
  address?: string;
}

interface Temp {
  file: string;
  text: string;
  CreateDate?: string;
}
interface ManagedTemplate extends VisualTemplateItem { text: string }

const tableData = ref<Sub[]>([]);
const table = ref();
const appStore = useAppStore();
const isMobile = computed(() => appStore.device === DeviceEnum.MOBILE);
const NodesList = ref<Node[]>([]);
const templist = ref<Temp[]>([]);
const managedTemplist = ref<ManagedTemplate[]>([]);
const multipleSelection = ref<Sub[]>([]);
const subscriptionSortMode = ref(false);

const dialogVisible = ref(false);
const subMode = ref<"add" | "edit">("add");
const wizardStep = ref(0);
const SubTitle = computed(() =>
  subMode.value === "add" ? "添加订阅" : "编辑订阅"
);
const Subname = ref("");
const oldSubname = ref("");
const expireAt = ref("");
const accessLimit = ref<number | undefined>();
const OutputType = ref<SubscriptionOutputType>("clash");
const EgernUpdateInterval = ref(1440);

const Clash = ref("");
const Surge = ref("");
const Egern = ref("");
const Loon = ref("");
const clashTemplateSelectRef = ref<{ blur: () => void }>();
const surgeTemplateSelectRef = ref<{ blur: () => void }>();
const egernTemplateSelectRef = ref<{ blur: () => void }>();
const loonTemplateSelectRef = ref<{ blur: () => void }>();
const clashTemplateMode = ref<"local" | "managed" | "url">("local");
const surgeTemplateMode = ref<"local" | "url">("local");
const egernTemplateMode = ref<"local" | "managed" | "url">("local");
const loonTemplateMode = ref<"local" | "managed" | "url">("local");
const checkList = ref<string[]>([]);

const value1 = ref<number[]>([]);
const nodeKeyword = ref("");
const groupNodeRules = ref<Record<string, PolicyGroupNodeRule>>({});
const groupNodesTemplate = ref("");
const manualGroupNames = ref<string[]>([]);
const manualGroupName = ref("");

const iplogsdialog = ref(false);
const IplogsList = ref<SubLogs[]>([]);

const qrcode = ref("");
const Qrdialog = ref(false);
const QrTitle = ref("");

const ClientDiaLog = ref(false);
interface ClientLink {
  url: string;
  description: string;
}

const ClientUrls = ref<Record<string, ClientLink>>({});
const ClientSubName = ref("");

const previewDialog = ref(false);
const previewLoading = ref(false);
const previewSubName = ref("");
const previewFormat = ref("");
const previewFilename = ref("");
const previewContent = ref("");
const previewNodeCount = ref(0);

const closeClashTemplateSelect = () => {
  nextTick(() => clashTemplateSelectRef.value?.blur());
};

const closeSurgeTemplateSelect = () => {
  nextTick(() => surgeTemplateSelectRef.value?.blur());
};

const closeEgernTemplateSelect = () => {
  nextTick(() => egernTemplateSelectRef.value?.blur());
};

const closeLoonTemplateSelect = () => {
  nextTick(() => loonTemplateSelectRef.value?.blur());
};

async function getsubs() {
  const { data } = await getSubs();
  tableData.value = data;
}

async function gettemps() {
  const { data } = await getTemp();
  templist.value = data;
  try {
    const { data: managed } = await listVisualTemplates();
    managedTemplist.value = await Promise.all((managed || []).map(async (item: VisualTemplateItem) => {
      const { data: detail } = await getVisualTemplate(item.file);
      return { ...item, text: detail.content };
    }));
  } catch {
    // Older servers may not expose template management yet; original templates remain usable.
    managedTemplist.value = [];
  }
}

async function getnodes() {
  const { data } = await getNodes({ all: "1" });
  NodesList.value = data;
}

function formatCreatedAt(row: Sub) {
  return formatBeijingTime(row.CreatedAt || row.CreateDate);
}

onMounted(() => {
  getsubs();
  gettemps();
  getnodes();
});

const currentPage = ref(1);
const pageSize = ref(10);
const currentTableData = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value;
  return tableData.value.slice(start, start + pageSize.value);
});
const selectedSubIds = computed(
  () => new Set(multipleSelection.value.map((item) => item.ID))
);
useDraggableTableRows({
  tableRef: table,
  rows: tableData,
  enabled: computed(() => subscriptionSortMode.value && !isMobile.value),
  startIndex: () => (currentPage.value - 1) * pageSize.value,
  storageKey: "sublink:subscriptions:order",
  rowKey: (row) => row.ID,
});

const availableNodes = computed(() => {
  const keyword = nodeKeyword.value.trim().toLowerCase();
  return NodesList.value.filter((node) => {
    if (node.Disabled) return false;
    if (value1.value.includes(node.ID)) return false;
    if (!keyword) return true;
    return node.Name.toLowerCase().includes(keyword);
  });
});

const nodeById = (id: number) =>
  NodesList.value.find((node) => node.ID === id) || {
    ID: id,
    Name: String(id),
    Link: "",
    Disabled: false,
  };

const isNodeDisabledById = (id: number) => Boolean(nodeById(id).Disabled);

const sortedSelectedNodeIds = computed(() => [
  ...value1.value.filter((id) => !isNodeDisabledById(id)),
  ...value1.value.filter((id) => isNodeDisabledById(id)),
]);

const selectedNodes = computed(() =>
  sortedSelectedNodeIds.value.map((id) => nodeById(id))
);

const selectedActiveNodes = computed(() =>
  selectedNodes.value.filter((node) => !node.Disabled)
);

const selectedDisabledNodes = computed(() =>
  selectedNodes.value.filter((node) => node.Disabled)
);

const selectedActiveNodeIds = computed(() =>
  selectedActiveNodes.value.map((node) => node.ID)
);

const selectedDisabledNodeIds = computed(() =>
  selectedDisabledNodes.value.map((node) => node.ID)
);

const draggableSelectedNodeIds = computed({
  get: () => selectedActiveNodeIds.value,
  set: (ids: number[]) => {
    value1.value = [...ids, ...selectedDisabledNodeIds.value];
  },
});

const selectedNodeNames = computed(() =>
  selectedActiveNodes.value.map((node) => node.Name)
);

const wizardTitles = [
  "基本信息",
  "输出模板",
  "选择节点",
  "策略组分配",
  "确认保存",
];

const nodeNameById = (id: number) => nodeById(id).Name;

const selectedNodePreview = computed(() => {
  if (!value1.value.length) return "尚未选择节点";
  const head = sortedSelectedNodeIds.value
    .slice(0, 4)
    .map(nodeNameById)
    .join(" → ");
  const suffix = selectedDisabledNodes.value.length
    ? `，含 ${selectedDisabledNodes.value.length} 个已禁用节点`
    : "";
  return `${value1.value.length > 4 ? `${head} → ...` : head}${suffix}`;
});

const defaultTemplate = (keyword: string, fallback: string) => {
  const hit = templist.value.find((item) =>
    item.file.toLowerCase().includes(keyword)
  );
  return hit ? `./template/${hit.file}` : fallback;
};

const localTemplateText = (value: string) => {
  const filename = value.replace(/^\.\/template\//, "");
  if (/^\.\/rule_templates\//.test(value)) {
    return managedTemplist.value.find((item) => item.file === value.replace(/^\.\/rule_templates\//, ""))?.text || "";
  }
  return templist.value.find((item) => item.file === filename)?.text || "";
};

const templateDisplayName = (value: string) => {
  if (!value) return "未选择模板";
  if (/^https?:\/\//i.test(value)) return value;
  return value.replace(/^\.\/(template|rule_templates)\//, "");
};

const managedByType = (type: "clash" | "egern" | "loon") =>
  computed(() => managedTemplist.value.filter((item) => item.type === type));
const clashManagedTemplates = managedByType("clash");
const egernManagedTemplates = managedByType("egern");
const loonManagedTemplates = managedByType("loon");

const uniqueStrings = (items: string[]) =>
  Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));

const parseClashGroupNames = (text: string) => {
  const groups: string[] = [];
  const lines = text.split(/\r?\n/);
  let inProxyGroups = false;
  let proxyGroupIndent = 0;
  let currentItemIndent = 0;

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const indent = line.search(/\S|$/);
    if (/^proxy-groups\s*:/.test(trimmed)) {
      inProxyGroups = true;
      proxyGroupIndent = indent;
      currentItemIndent = indent + 2;
      return;
    }
    if (
      inProxyGroups &&
      indent <= proxyGroupIndent &&
      !trimmed.startsWith("-")
    ) {
      inProxyGroups = false;
    }
    if (!inProxyGroups) return;
    const inlineName = trimmed.match(/^-\s*name\s*:\s*["']?(.+?)["']?\s*$/);
    const blockName = trimmed.match(/^name\s*:\s*["']?(.+?)["']?\s*$/);
    if (inlineName) {
      currentItemIndent = indent;
      groups.push(inlineName[1]);
      return;
    }
    if (blockName && indent > currentItemIndent) {
      groups.push(blockName[1]);
    }
  });

  return uniqueStrings(groups);
};

const parseSurgeGroupNames = (text: string) => {
  const groups: string[] = [];
  const section = text.match(/\[Proxy Group\]([\s\S]*?)(?:\n\[|$)/i)?.[1] || "";
  section.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return;
    groups.push(trimmed.split("=")[0].trim());
  });
  return uniqueStrings(groups);
};

const parseEgernGroupNames = (text: string) => {
  const groups: string[] = [];
  const lines = text.split(/\r?\n/);
  let inPolicyGroups = false;
  let policyGroupsIndent = 0;

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const indent = line.search(/\S|$/);
    if (/^policy_groups\s*:/.test(trimmed)) {
      inPolicyGroups = true;
      policyGroupsIndent = indent;
      return;
    }
    if (
      inPolicyGroups &&
      indent <= policyGroupsIndent &&
      !trimmed.startsWith("-")
    ) {
      inPolicyGroups = false;
    }
    if (!inPolicyGroups) return;
    const name = trimmed.match(/^name\s*:\s*["']?(.+?)["']?\s*$/);
    if (name) groups.push(name[1]);
  });

  return uniqueStrings(groups);
};

const selectedTemplateSource = computed(() => {
  switch (OutputType.value) {
    case "surge":
      return Surge.value.trim();
    case "egern":
      return Egern.value.trim();
    case "loon":
      return Loon.value.trim();
    default:
      return Clash.value.trim();
  }
});

const groupTemplateOptions = computed(() =>
  uniqueStrings([selectedTemplateSource.value]).map((value) => ({
    label: templateDisplayName(value),
    value,
  }))
);

const ensureGroupNodesTemplate = () => {
  const optionValues = groupTemplateOptions.value.map((item) => item.value);
  if (!optionValues.length) {
    groupNodesTemplate.value = "";
    return;
  }
  if (!optionValues.includes(groupNodesTemplate.value)) {
    groupNodesTemplate.value = optionValues[0];
  }
};

const templateGroupNames = computed(() => {
  const templateText = localTemplateText(groupNodesTemplate.value);
  const parsedGroups = uniqueStrings([
    ...parseClashGroupNames(templateText),
    ...parseSurgeGroupNames(templateText),
    ...parseEgernGroupNames(templateText),
  ]);
  const fallbackGroups = templateText ? [] : Object.keys(groupNodeRules.value);
  return uniqueStrings([
    ...parsedGroups,
    ...fallbackGroups,
    ...manualGroupNames.value,
  ]);
});

const groupRuleRows = computed(() =>
  templateGroupNames.value.map((name) => ({
    name,
    rule: groupNodeRules.value[name] || { mode: "all", nodes: [] },
  }))
);

const selectedGroupSummary = computed(() => {
  const rows = groupRuleRows.value;
  if (!rows.length)
    return "未识别到策略组，生成时未配置的策略组仍默认加入全部节点";
  const includeCount = rows.filter(
    (item) => item.rule.mode === "include"
  ).length;
  const noneCount = rows.filter((item) => item.rule.mode === "none").length;
  return `共 ${rows.length} 个策略组，${includeCount} 个指定节点，${noneCount} 个不自动添加，其余默认全部节点`;
});

const ensureGroupRule = (name: string) => {
  if (!groupNodeRules.value[name]) {
    groupNodeRules.value[name] = { mode: "all", nodes: [] };
  }
  return groupNodeRules.value[name];
};

const updateGroupMode = (
  name: string,
  mode: string | number | boolean | undefined
) => {
  const rule = ensureGroupRule(name);
  const nextMode = ["include", "none"].includes(String(mode))
    ? (String(mode) as PolicyGroupNodeRule["mode"])
    : "all";
  rule.mode = nextMode;
  if (nextMode !== "include") {
    rule.nodes = [];
  } else {
    rule.nodes = (rule.nodes || []).filter((node) =>
      selectedNodeNames.value.includes(node)
    );
  }
};

const updateGroupNodes = (name: string, nodes: string[]) => {
  const rule = ensureGroupRule(name);
  rule.mode = "include";
  rule.nodes = nodes.filter((node) => selectedNodeNames.value.includes(node));
};

const toggleMobileGroupNode = (
  groupName: string,
  nodeName: string,
  selected: boolean
) => {
  const nodes = new Set(ensureGroupRule(groupName).nodes || []);
  if (selected) {
    nodes.add(nodeName);
  } else {
    nodes.delete(nodeName);
  }
  updateGroupNodes(groupName, Array.from(nodes));
};

const addManualGroup = () => {
  const name = manualGroupName.value.trim();
  if (!name) return;
  ensureGroupRule(name);
  if (!manualGroupNames.value.includes(name)) {
    manualGroupNames.value = [...manualGroupNames.value, name];
  }
  manualGroupName.value = "";
};

const resetGroupRule = (name: string) => {
  const nextRules = { ...groupNodeRules.value };
  delete nextRules[name];
  groupNodeRules.value = nextRules;
  manualGroupNames.value = manualGroupNames.value.filter(
    (item) => item !== name
  );
};

const parseConfig = (value: Config | string): Config => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Config;
    } catch {
      return {
        clash: "",
        surge: "",
        egern: "",
        loon: "",
        udp: false,
        cert: false,
      };
    }
  }
  return (
    value || {
      clash: "",
      surge: "",
      egern: "",
      loon: "",
      udp: false,
      cert: false,
    }
  );
};

const inferSubscriptionOutputType = (
  config: Config,
  subscriptionName = ""
): SubscriptionOutputType => {
  if (["clash", "surge", "egern", "loon"].includes(config.output_type || "")) {
    return config.output_type as SubscriptionOutputType;
  }
  const normalizedName = subscriptionName.trim().toLowerCase();
  if (normalizedName.includes("egern")) return "egern";
  if (normalizedName.includes("loon")) return "loon";
  if (normalizedName.includes("surge")) return "surge";
  return "clash";
};

const inferTemplateMode = (value: string): "local" | "managed" | "url" =>
  /^https?:\/\//i.test(value) ? "url" : /^\.\/rule_templates\//.test(value) ? "managed" : "local";
const inferBasicTemplateMode = (value: string): "local" | "url" =>
  /^https?:\/\//i.test(value) ? "url" : "local";

const resetWizardForm = () => {
  wizardStep.value = 0;
  Subname.value = "";
  oldSubname.value = "";
  expireAt.value = "";
  accessLimit.value = undefined;
  OutputType.value = "clash";
  EgernUpdateInterval.value = 1440;
  checkList.value = [];
  Clash.value = defaultTemplate("clash", "./template/clash.yaml");
  Surge.value = defaultTemplate("surge", "./template/surge.conf");
  Egern.value = defaultTemplate("egern", "./template/egern.yaml");
  Loon.value = defaultTemplate("loon", "./template/loon.conf");
  clashTemplateMode.value = inferTemplateMode(Clash.value);
  surgeTemplateMode.value = inferBasicTemplateMode(Surge.value);
  egernTemplateMode.value = inferTemplateMode(Egern.value);
  loonTemplateMode.value = inferTemplateMode(Loon.value);
  groupNodesTemplate.value = selectedTemplateSource.value;
  value1.value = [];
  nodeKeyword.value = "";
  groupNodeRules.value = {};
  manualGroupName.value = "";
  manualGroupNames.value = [];
};

const handleAddSub = () => {
  subMode.value = "add";
  resetWizardForm();
  dialogVisible.value = true;
};

const handleEdit = (row: any) => {
  const config = parseConfig(row.Config);
  subMode.value = "edit";
  wizardStep.value = 0;
  Subname.value = row.Name;
  oldSubname.value = row.Name;
  expireAt.value = row.ExpireAt
    ? new Date(row.ExpireAt).toISOString().slice(0, 19).replace("T", " ")
    : "";
  accessLimit.value = row.AccessLimit || undefined;
  OutputType.value = inferSubscriptionOutputType(config, row.Name);
  EgernUpdateInterval.value =
    Number(config.egern_update_interval) > 0
      ? Number(config.egern_update_interval)
      : 1440;
  checkList.value = [];
  if (config.udp === true || config.udp === "true") checkList.value.push("udp");
  if (config.cert === true || config.cert === "true")
    checkList.value.push("cert");
  Clash.value =
    config.clash || defaultTemplate("clash", "./template/clash.yaml");
  Surge.value =
    config.surge || defaultTemplate("surge", "./template/surge.conf");
  Egern.value =
    config.egern || defaultTemplate("egern", "./template/egern.yaml");
  Loon.value = config.loon || defaultTemplate("loon", "./template/loon.conf");
  clashTemplateMode.value = inferTemplateMode(Clash.value);
  surgeTemplateMode.value = inferBasicTemplateMode(Surge.value);
  egernTemplateMode.value = inferTemplateMode(Egern.value);
  loonTemplateMode.value = inferTemplateMode(Loon.value);
  groupNodesTemplate.value =
    config.group_nodes_template === selectedTemplateSource.value
      ? config.group_nodes_template
      : selectedTemplateSource.value;
  value1.value = (row.Nodes || []).map((item: Node) => item.ID);
  nodeKeyword.value = "";
  groupNodeRules.value = { ...(config.group_nodes || {}) };
  manualGroupName.value = "";
  manualGroupNames.value = [];
  dialogVisible.value = true;
};

const validateStep = (step: number) => {
  if (step === 0) {
    if (!Subname.value.trim()) {
      ElMessage.warning("请输入订阅名称");
      return false;
    }
  }
  if (step === 1) {
    if (!selectedTemplateSource.value) {
      ElMessage.warning(`请选择或填写 ${OutputType.value} 模板`);
      return false;
    }
    if (
      OutputType.value === "egern" &&
      (!Number.isInteger(EgernUpdateInterval.value) ||
        EgernUpdateInterval.value < 1)
    ) {
      ElMessage.warning("Egern 自动更新间隔必须是大于 0 的整数分钟");
      return false;
    }
  }
  if (step === 2) {
    if (!value1.value.length) {
      ElMessage.warning("至少选择一个节点");
      return false;
    }
  }
  return true;
};

const nextStep = () => {
  if (!validateStep(wizardStep.value)) return;
  wizardStep.value = Math.min(wizardStep.value + 1, 4);
};

const prevStep = () => {
  wizardStep.value = Math.max(wizardStep.value - 1, 0);
};

const jumpStep = (step: number) => {
  if (step <= wizardStep.value) {
    wizardStep.value = step;
  }
};

const addNodeToSelection = (id: number) => {
  if (!value1.value.includes(id)) {
    value1.value = [
      ...selectedActiveNodeIds.value,
      id,
      ...selectedDisabledNodeIds.value,
    ];
  }
};

const removeNodeFromSelection = (id: number) => {
  value1.value = value1.value.filter((item) => item !== id);
};

const addAllVisibleNodes = () => {
  availableNodes.value.forEach((node) => addNodeToSelection(node.ID));
};

const restoreSelectedNode = async (id: number) => {
  await setNodeDisabled({
    id,
    disabled: false,
  });
  await getnodes();
  value1.value = sortedSelectedNodeIds.value;
  ElMessage.success(`${nodeNameById(id)} 已恢复`);
};

const restoreAllSelectedDisabledNodes = async () => {
  const ids = [...selectedDisabledNodeIds.value];
  if (!ids.length) return;
  await Promise.all(
    ids.map((id) =>
      setNodeDisabled({
        id,
        disabled: false,
      })
    )
  );
  await getnodes();
  value1.value = sortedSelectedNodeIds.value;
  ElMessage.success(`已恢复 ${ids.length} 个禁用节点`);
};

const clearSelectedNodes = () => {
  value1.value = [];
};

watch(value1, () => {
  const selected = new Set(selectedNodeNames.value);
  Object.values(groupNodeRules.value).forEach((rule) => {
    if (rule.mode === "include") {
      rule.nodes = (rule.nodes || []).filter((node) => selected.has(node));
    }
  });
});

watch([Clash, Surge, Egern, Loon, OutputType], ensureGroupNodesTemplate);

const serializedGroupRules = () => {
  const result: Record<string, PolicyGroupNodeRule> = {};
  templateGroupNames.value.forEach((name) => {
    const rule = groupNodeRules.value[name];
    if (!rule) {
      return;
    }
    result[name] = {
      mode: rule.mode || "all",
      nodes:
        rule.mode === "include"
          ? (rule.nodes || []).filter((node) =>
              selectedNodeNames.value.includes(node)
            )
          : [],
    };
  });
  return result;
};

const buildConfig = () =>
  JSON.stringify({
    output_type: OutputType.value,
    clash: OutputType.value === "clash" ? Clash.value.trim() : "",
    surge: OutputType.value === "surge" ? Surge.value.trim() : "",
    egern: OutputType.value === "egern" ? Egern.value.trim() : "",
    loon: OutputType.value === "loon" ? Loon.value.trim() : "",
    egern_update_interval:
      OutputType.value === "egern" ? EgernUpdateInterval.value : 0,
    udp: checkList.value.includes("udp"),
    cert: checkList.value.includes("cert"),
    group_nodes: serializedGroupRules(),
    group_nodes_template: groupNodesTemplate.value.trim(),
  });

const addSubs = async () => {
  if (!validateStep(0) || !validateStep(1) || !validateStep(2)) return;

  const payload = {
    config: buildConfig(),
    name: Subname.value.trim(),
    nodes: sortedSelectedNodeIds.value.join(","),
    expire_at: expireAt.value || "",
    access_limit: accessLimit.value || "",
  };

  if (subMode.value === "add") {
    await AddSub(payload);
    ElMessage.success("添加成功");
  } else {
    await UpdateSub({
      ...payload,
      oldname: oldSubname.value,
    });
    ElMessage.success("更新成功");
  }

  await getsubs();
  dialogVisible.value = false;
  const saved = tableData.value.find((item) => item.Name === payload.name);
  if (saved) {
    handleClient(saved);
  }
};

const handleSelectionChange = (val: Sub[]) => {
  multipleSelection.value = val;
};

const selectAll = () => {
  if (isMobile.value) {
    multipleSelection.value = [...currentTableData.value];
    return;
  }
  tableData.value.forEach((row) => {
    table.value.toggleRowSelection(row, true);
  });
};

const toggleSelection = () => {
  if (isMobile.value) {
    multipleSelection.value = [];
    return;
  }
  table.value.clearSelection();
};

const handleSizeChange = (val: number) => {
  pageSize.value = val;
};

const handleCurrentChange = (val: number) => {
  currentPage.value = val;
};

const handleIplogs = (row: any) => {
  iplogsdialog.value = true;
  nextTick(() => {
    IplogsList.value = row.SubLogs || [];
  });
};

const isSubExpired = (row: Sub) =>
  Boolean(row.ExpireAt && beijingTimestamp(row.ExpireAt) < Date.now());

const subStatusText = (row: Sub) => {
  if (row.Revoked) return "已失效";
  if (isSubExpired(row)) return "已过期";
  return "有效";
};

const subStatusClass = (row: Sub) => ({
  "is-danger": row.Revoked,
  "is-warning": !row.Revoked && isSubExpired(row),
});

const subNodeSummary = (row: Sub) => {
  const nodes = row.Nodes || [];
  if (!nodes.length) return "未选择节点";
  const head = nodes
    .slice(0, 3)
    .map((node) => node.Name)
    .join(" / ");
  return nodes.length > 3 ? `${head} 等 ${nodes.length} 个` : head;
};

const isSubSelected = (row: Sub) => selectedSubIds.value.has(row.ID);

const toggleMobileSubSelection = (row: Sub, checked: boolean) => {
  if (checked) {
    if (!isSubSelected(row)) {
      multipleSelection.value = [...multipleSelection.value, row];
    }
    return;
  }
  multipleSelection.value = multipleSelection.value.filter(
    (item) => item.ID !== row.ID
  );
};

const handleDel = (row: any) => {
  ElMessageBox.confirm(`你是否要删除 ${row.Name} ?`, "提示", {
    confirmButtonText: "确定",
    cancelButtonText: "取消",
    type: "warning",
  }).then(async () => {
    await DelSub({ id: row.ID });
    await getsubs();
    ElMessage.success("删除成功");
  });
};

const handleResetToken = async (row: any) => {
  await ElMessageBox.confirm(
    `重置 ${row.Name} 的订阅 token？旧 token 会立刻失效。`,
    "重置 token",
    {
      confirmButtonText: "重置",
      cancelButtonText: "取消",
      type: "warning",
    }
  );
  await ResetSubToken({ id: row.ID });
  await getsubs();
  ElMessage.success("token 已重置");
};

const handleToggleRevoked = async (row: any) => {
  await SetSubRevoked({ id: row.ID, revoked: !row.Revoked });
  await getsubs();
  ElMessage.success(row.Revoked ? "订阅已恢复" : "订阅已手动失效");
};

const selectDel = () => {
  if (multipleSelection.value.length === 0) return;
  ElMessageBox.confirm("你是否要删除选中的订阅？", "提示", {
    confirmButtonText: "确定",
    cancelButtonText: "取消",
    type: "warning",
  }).then(async () => {
    await Promise.all(
      multipleSelection.value.map((item) => DelSub({ id: item.ID }))
    );
    await getsubs();
    ElMessage.success("删除成功");
  });
};

const copyUrl = (url: string) => {
  const textarea = document.createElement("textarea");
  textarea.value = url;
  document.body.appendChild(textarea);
  textarea.select();
  try {
    const successful = document.execCommand("copy");
    ElMessage({
      type: successful ? "success" : "warning",
      message: successful ? "复制成功" : "复制失败",
    });
  } catch {
    ElMessage.warning("复制失败");
  } finally {
    document.body.removeChild(textarea);
  }
};

const copyInfo = (row: any) => {
  copyUrl(row.Link);
};

const handleClient = (row: any) => {
  const serverAddress =
    location.protocol +
    "//" +
    location.hostname +
    (location.port ? ":" + location.port : "");
  ClientDiaLog.value = true;
  ClientSubName.value = row.Name;
  ClientUrls.value = {};
  const config = parseConfig(row.Config);
  const outputType = inferSubscriptionOutputType(config, row.Name);
  const clients = outputType === "clash" ? ["clash", "v2ray"] : [outputType];
  clients.forEach((item: string) => {
    const subscriptionURL =
      `${serverAddress}/c/?token=${row.Token}&client=${item}`;
    ClientUrls.value[item] = {
      url: subscriptionURL,
      description: `使用 ${item} 专用订阅地址。`,
    };
  });
};

const handlePreviewSub = async (row: any) => {
  previewDialog.value = true;
  previewLoading.value = true;
  previewSubName.value = row.Name;
  previewFormat.value = "";
  previewFilename.value = "";
  previewContent.value = "";
  previewNodeCount.value = 0;
  try {
    const config = parseConfig(row.Config);
    const outputType = inferSubscriptionOutputType(config, row.Name);
    const { data } = await PreviewSub({
      id: row.ID,
      client: outputType,
    });
    previewSubName.value = data.name || row.Name;
    previewFormat.value = data.format || outputType;
    previewFilename.value = data.filename || `${row.Name}.${outputType}`;
    previewContent.value = data.content || "";
    previewNodeCount.value = Number(data.node_count || 0);
  } catch (error: any) {
    previewDialog.value = false;
    ElMessage.error(error?.response?.data?.msg || "订阅文件生成失败");
  } finally {
    previewLoading.value = false;
  }
};

const copyPreviewContent = () => {
  copyUrl(previewContent.value);
};

const downloadPreviewContent = () => {
  const blob = new Blob([previewContent.value], {
    type: "text/plain;charset=utf-8",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = previewFilename.value || `${previewSubName.value}.txt`;
  document.body.appendChild(link);
  link.click();
  URL.revokeObjectURL(link.href);
  document.body.removeChild(link);
};

const handleQrcode = (url: string, title: string) => {
  Qrdialog.value = true;
  qrcode.value = url;
  QrTitle.value = title;
};

const OpenUrl = (url: string) => {
  window.open(url);
};

const importLoon = (subscriptionURL: string) => {
  window.location.href = `loon://import?sub=${encodeURIComponent(subscriptionURL)}`;
};
</script>

<template>
  <div class="page-workspace mobile-page">
    <el-dialog
      v-model="Qrdialog"
      class="form-dialog qr-dialog"
      width="400px"
      :title="QrTitle"
    >
      <div class="qr-content">
        <div class="qr-frame">
          <qrcode-vue :value="qrcode" :size="196" level="H" />
        </div>
        <el-input v-model="qrcode" readonly />
      </div>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="copyUrl(qrcode)">复制地址</el-button>
          <el-button type="primary" @click="OpenUrl(qrcode)"
            >打开链接</el-button
          >
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="ClientDiaLog"
      class="form-dialog client-dialog"
      width="760px"
      title="订阅链接"
    >
      <div class="client-dialog-head">
        <div>
          <p class="dialog-intro">仅显示当前订阅类型支持的链接。</p>
          <strong>{{ ClientSubName }}</strong>
        </div>
      </div>
      <div class="client-card-list">
        <article
          v-for="(item, index) in ClientUrls"
          :key="index"
          class="client-card"
        >
          <div class="client-card-title">
            <span>{{ index }}</span>
            <el-tag size="small" effect="plain">{{ index }}</el-tag>
          </div>
          <p>{{ item.description }}</p>
          <el-input
            :model-value="item.url"
            readonly
            class="client-url-input"
          />
          <div class="client-actions">
            <el-button @click="copyUrl(item.url)">复制链接</el-button>
            <el-button @click="handleQrcode(item.url, String(index))"
              >二维码</el-button
            >
            <el-button @click="OpenUrl(item.url)">打开</el-button>
            <el-button
              v-if="index === 'loon'"
              @click="importLoon(item.url)"
              >导入 Loon</el-button
            >
          </div>
        </article>
      </div>
    </el-dialog>

    <el-dialog
      v-model="previewDialog"
      class="form-dialog subscription-preview-dialog"
      width="min(1040px, calc(100vw - 32px))"
      title="查看订阅文件"
      :close-on-click-modal="true"
    >
      <div v-loading="previewLoading" class="subscription-preview">
        <div class="preview-head">
          <div>
            <p class="dialog-intro">
              后台生成的可读源配置，仅用于查看；浏览器订阅链接输出保持不变。
            </p>
            <strong>{{ previewSubName }}</strong>
          </div>
          <div class="preview-meta">
            <el-tag size="small" effect="plain">{{ previewFormat }}</el-tag>
            <span>{{ previewFilename }}</span>
            <span>{{ previewNodeCount }} 个节点</span>
          </div>
        </div>
        <pre class="preview-code"><code>{{ previewContent }}</code></pre>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="copyPreviewContent">复制内容</el-button>
          <el-button @click="downloadPreviewContent">下载文件</el-button>
          <el-button type="primary" @click="previewDialog = false">
            关闭
          </el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="iplogsdialog"
      class="data-dialog"
      title="访问记录"
      width="min(880px, calc(100vw - 32px))"
    >
      <el-table
        class="desktop-data-table"
        :data="IplogsList"
        style="width: 100%"
      >
        <el-table-column prop="IP" label="IP" />
        <el-table-column prop="Count" label="总访问次数" />
        <el-table-column prop="Addr" label="来源" />
        <el-table-column prop="Date" label="最近时间" />
      </el-table>
      <div class="mobile-only-list mobile-card-list iplog-mobile-list">
        <div v-if="IplogsList.length === 0" class="mobile-empty-state">
          暂无访问记录
        </div>
        <article
          v-for="(log, index) in IplogsList"
          :key="`${log.IP || log.ip}-${index}`"
          class="mobile-card"
        >
          <div class="mobile-card-top">
            <div class="mobile-card-title">
              <strong>{{ log.IP || log.ip || "未知 IP" }}</strong>
              <small>{{ log.Date || log.date || "未知时间" }}</small>
            </div>
            <span class="mobile-status"
              >{{ log.Count || log.count || 0 }} 次</span
            >
          </div>
          <div class="mobile-field">
            <span>来源</span>
            <strong>{{ log.Addr || log.address || "未知" }}</strong>
          </div>
        </article>
      </div>
    </el-dialog>

    <el-dialog
      v-model="dialogVisible"
      class="form-dialog subscription-wizard-dialog"
      width="min(1040px, calc(100vw - 32px))"
      :close-on-click-modal="true"
      destroy-on-close
    >
      <template #header>
        <div class="dialog-heading">
          <h2>{{ SubTitle }}</h2>
          <p>按步骤配置订阅信息、输出模板、节点顺序和策略组节点分配。</p>
        </div>
      </template>

      <el-steps
        :active="wizardStep"
        finish-status="success"
        class="wizard-steps"
        simple
      >
        <el-step title="基本信息" @click="jumpStep(0)" />
        <el-step title="输出模板" @click="jumpStep(1)" />
        <el-step title="选择节点" @click="jumpStep(2)" />
        <el-step title="策略组分配" @click="jumpStep(3)" />
        <el-step title="确认保存" @click="jumpStep(4)" />
      </el-steps>

      <div class="mobile-wizard-status">
        <span>步骤 {{ wizardStep + 1 }} / 5</span>
        <strong>{{ wizardTitles[wizardStep] }}</strong>
      </div>

      <section v-show="wizardStep === 0" class="wizard-panel">
        <div class="panel-copy">
          <h3>基本信息</h3>
          <p>先定义订阅名称、到期时间和访问限制。</p>
        </div>
        <div class="form-grid">
          <label class="field field-full">
            <span class="field-label">订阅名称</span>
            <el-input v-model="Subname" placeholder="例如 myclash" />
          </label>
          <label class="field">
            <span class="field-label">到期时间</span>
            <el-date-picker
              v-model="expireAt"
              type="datetime"
              value-format="YYYY-MM-DD HH:mm:ss"
              placeholder="不填表示永不过期"
              style="width: 100%"
            />
          </label>
          <label class="field">
            <span class="field-label">访问次数限制</span>
            <el-input-number
              v-model="accessLimit"
              :min="0"
              controls-position="right"
              placeholder="0 为不限"
              style="width: 100%"
            />
          </label>
        </div>
      </section>

      <section v-show="wizardStep === 1" class="wizard-panel">
        <div class="panel-copy">
          <h3>输出模板</h3>
          <p>选择订阅类型后，只需配置该类型对应的模板。</p>
        </div>
        <div class="field">
          <span class="field-label">订阅类型</span>
          <el-radio-group v-model="OutputType" class="flat-segmented">
            <el-radio-button value="clash">Clash / V2Ray</el-radio-button>
            <el-radio-button value="surge">Surge</el-radio-button>
            <el-radio-button value="egern">Egern</el-radio-button>
            <el-radio-button value="loon">Loon</el-radio-button>
          </el-radio-group>
        </div>
        <div class="template-grid">
          <article v-if="OutputType === 'clash'" class="template-card">
            <div class="template-card-head">
              <strong>Clash</strong>
            </div>
            <TemplateSourcePicker v-model="Clash" v-model:mode="clashTemplateMode" label="Clash" :local-templates="templist" :managed-templates="clashManagedTemplates" />
          </article>

          <article v-if="OutputType === 'surge'" class="template-card">
            <div class="template-card-head">
              <strong>Surge</strong>
              <el-radio-group
                v-model="surgeTemplateMode"
                class="flat-segmented"
                size="small"
              >
                <el-radio-button value="local">本地模板</el-radio-button>
                <el-radio-button value="url">URL</el-radio-button>
              </el-radio-group>
            </div>
            <el-select
              v-if="surgeTemplateMode === 'local'"
              ref="surgeTemplateSelectRef"
              v-model="Surge"
              placeholder="选择 Surge 模板"
              @change="closeSurgeTemplateSelect"
            >
              <el-option
                v-for="template in templist"
                :key="template.file"
                :label="template.file"
                :value="'./template/' + template.file"
              />
            </el-select>
            <el-input
              v-else
              v-model="Surge"
              placeholder="输入 Surge 模板 URL"
            />
          </article>

          <article v-if="OutputType === 'egern'" class="template-card">
            <div class="template-card-head">
              <strong>Egern</strong>
            </div>
            <TemplateSourcePicker v-model="Egern" v-model:mode="egernTemplateMode" label="Egern" :local-templates="templist" :managed-templates="egernManagedTemplates" />
            <label class="field">
              <span class="field-label">自动更新间隔（分钟）</span>
              <el-input-number
                v-model="EgernUpdateInterval"
                :min="1"
                :max="525600"
                :step="1"
                controls-position="right"
                style="width: 100%"
              />
              <small class="field-hint">
                生成时自动写入当前订阅链接，并转换为
                {{ EgernUpdateInterval * 60 }} 秒。
              </small>
            </label>
          </article>

          <article v-if="OutputType === 'loon'" class="template-card">
            <div class="template-card-head">
              <strong>Loon</strong>
            </div>
            <TemplateSourcePicker v-model="Loon" v-model:mode="loonTemplateMode" label="Loon" :local-templates="templist" :managed-templates="loonManagedTemplates" />
            <small class="field-hint">
              默认模板已包含 [Proxy]，无需手动配置；自定义模板必须包含 [Proxy]。
            </small>
          </article>
        </div>
        <div class="field">
          <span class="field-label">连接选项</span>
          <el-checkbox-group v-model="checkList" class="option-list">
            <el-checkbox value="udp" border>启用 UDP</el-checkbox>
            <el-checkbox value="cert" border>跳过证书验证</el-checkbox>
          </el-checkbox-group>
        </div>
      </section>

      <section v-show="wizardStep === 2" class="wizard-panel">
        <div class="panel-copy">
          <h3>选择节点</h3>
          <p>左侧选择节点，右侧拖拽排序。订阅输出会按右侧顺序生成。</p>
        </div>
        <div class="node-picker">
          <section class="node-column">
            <div class="node-column-head">
              <strong>可选节点</strong>
              <el-button link type="primary" @click="addAllVisibleNodes"
                >加入当前列表</el-button
              >
            </div>
            <el-input
              v-model="nodeKeyword"
              clearable
              placeholder="搜索节点"
              class="node-search"
            />
            <div class="node-list">
              <button
                v-for="node in availableNodes"
                :key="node.ID || node.Name"
                class="node-option"
                type="button"
                @click="addNodeToSelection(node.ID)"
              >
                <span>{{ node.Name }}</span>
                <span>加入</span>
              </button>
              <div v-if="!availableNodes.length" class="node-empty">
                没有可加入的节点
              </div>
            </div>
          </section>

          <section class="node-column selected-column">
            <div class="node-column-head">
              <strong>
                已选节点 {{ value1.length }} 个
                <small v-if="selectedDisabledNodes.length">
                  ，{{ selectedDisabledNodes.length }} 个已禁用
                </small>
              </strong>
              <div class="selected-node-actions">
                <el-button
                  v-if="selectedDisabledNodes.length"
                  link
                  type="primary"
                  @click="restoreAllSelectedDisabledNodes"
                >
                  恢复禁用
                </el-button>
                <el-button link type="danger" @click="clearSelectedNodes"
                  >清空</el-button
                >
              </div>
            </div>
            <VueDraggable
              v-if="selectedActiveNodeIds.length"
              v-model="draggableSelectedNodeIds"
              :animation="150"
              ghost-class="ghost"
              class="selected-nodes"
            >
              <div
                v-for="(nodeId, index) in draggableSelectedNodeIds"
                :key="nodeId"
                class="draggable-item"
              >
                <span class="drag-handle">⋮⋮</span>
                <span class="row-number">{{ index + 1 }}</span>
                <span class="node-name">{{ nodeNameById(nodeId) }}</span>
                <el-button
                  link
                  type="danger"
                  @click.stop="removeNodeFromSelection(nodeId)"
                  >移除</el-button
                >
              </div>
            </VueDraggable>
            <div
              v-else-if="!selectedDisabledNodes.length"
              class="empty-selection"
            >
              尚未选择节点
            </div>
            <div
              v-if="selectedDisabledNodes.length"
              class="disabled-selected-nodes"
            >
              <div class="disabled-selected-head">
                <span>已禁用节点自动置底，不参与拖拽</span>
              </div>
              <div
                v-for="(node, index) in selectedDisabledNodes"
                :key="node.ID"
                class="disabled-selected-item"
              >
                <span class="drag-lock">锁</span>
                <span class="row-number">{{
                  selectedActiveNodeIds.length + index + 1
                }}</span>
                <span class="node-name">{{ node.Name }}</span>
                <el-tag size="small" type="info" effect="plain">已禁用</el-tag>
                <el-button
                  link
                  type="primary"
                  @click="restoreSelectedNode(node.ID)"
                  >恢复</el-button
                >
                <el-button
                  link
                  type="danger"
                  @click.stop="removeNodeFromSelection(node.ID)"
                  >移除</el-button
                >
              </div>
            </div>
          </section>
        </div>
      </section>

      <section v-show="wizardStep === 3" class="wizard-panel">
        <div class="panel-copy">
          <h3>策略组节点分配</h3>
          <p>
            只读取当前订阅使用的一个模板；默认每个策略组都会加入全部已选节点。
          </p>
        </div>

        <label class="field group-template-source">
          <span class="field-label">当前读取模板</span>
          <el-select
            v-model="groupNodesTemplate"
            placeholder="选择当前订阅实际使用的模板"
          >
            <el-option
              v-for="template in groupTemplateOptions"
              :key="template.value"
              :label="template.label"
              :value="template.value"
            />
          </el-select>
          <small>
            下方策略组只从这个模板解析；不会再混入当前订阅里另一个模板的策略组。
          </small>
        </label>

        <div class="manual-group-bar">
          <el-input
            v-model="manualGroupName"
            clearable
            placeholder="URL 模板无法识别时，可手动输入策略组名"
            @keyup.enter="addManualGroup"
          />
          <el-button type="primary" plain @click="addManualGroup"
            >添加策略组</el-button
          >
        </div>

        <div class="group-rule-list">
          <div v-if="groupRuleRows.length === 0" class="node-empty">
            暂未从本地模板识别到策略组。未配置的策略组在生成时仍会默认加入全部节点。
          </div>
          <article
            v-for="item in groupRuleRows"
            :key="item.name"
            class="group-rule-card"
          >
            <div class="group-rule-main">
              <strong>{{ item.name }}</strong>
              <small>
                {{
                  item.rule.mode === "include"
                    ? `指定 ${item.rule.nodes?.length || 0} 个节点`
                    : item.rule.mode === "none"
                      ? "不自动添加节点"
                      : "默认全部节点"
                }}
              </small>
              <el-button
                v-if="groupNodeRules[item.name]"
                link
                type="primary"
                class="group-reset-button"
                @click="resetGroupRule(item.name)"
              >
                重置默认
              </el-button>
            </div>
            <el-radio-group
              :model-value="item.rule.mode"
              class="group-mode"
              size="small"
              @change="(mode) => updateGroupMode(item.name, mode)"
            >
              <el-radio-button value="all">全部节点</el-radio-button>
              <el-radio-button value="include">指定节点</el-radio-button>
              <el-radio-button value="none">不添加</el-radio-button>
            </el-radio-group>
            <el-select
              v-if="item.rule.mode === 'include' && !isMobile"
              :model-value="item.rule.nodes || []"
              multiple
              filterable
              collapse-tags
              collapse-tags-tooltip
              placeholder="选择要放进该策略组的节点"
              @change="
                (nodes) => updateGroupNodes(item.name, nodes as string[])
              "
            >
              <el-option
                v-for="node in selectedActiveNodes"
                :key="node.ID"
                :label="node.Name"
                :value="node.Name"
              />
            </el-select>
            <div
              v-else-if="item.rule.mode === 'include'"
              class="mobile-node-choice-list"
            >
              <label
                v-for="node in selectedActiveNodes"
                :key="node.ID"
                class="mobile-node-choice"
                :class="{
                  'is-selected': (item.rule.nodes || []).includes(node.Name),
                }"
              >
                <input
                  type="checkbox"
                  :checked="(item.rule.nodes || []).includes(node.Name)"
                  @change="
                    (event) =>
                      toggleMobileGroupNode(
                        item.name,
                        node.Name,
                        (event.target as HTMLInputElement).checked
                      )
                  "
                />
                <span>{{ node.Name }}</span>
              </label>
            </div>
          </article>
        </div>
      </section>

      <section v-show="wizardStep === 4" class="wizard-panel">
        <div class="panel-copy">
          <h3>确认保存</h3>
          <p>确认无误后保存。保存成功后会直接打开订阅链接弹窗。</p>
        </div>
        <div class="summary-grid">
          <article class="summary-card">
            <span>订阅名称</span>
            <strong>{{ Subname || "未填写" }}</strong>
          </article>
          <article class="summary-card">
            <span>有效期</span>
            <strong>{{ expireAt || "永不过期" }}</strong>
          </article>
          <article class="summary-card">
            <span>访问限制</span>
            <strong
              >{{ accessLimit || 0 }}
              {{ accessLimit ? "次" : "为不限" }}</strong
            >
          </article>
          <article class="summary-card">
            <span>节点数量</span>
            <strong>{{ value1.length }} 个</strong>
          </article>
        </div>
        <div class="summary-block">
          <strong>模板</strong>
          <p>订阅类型：{{ OutputType }}</p>
          <p>{{ templateDisplayName(selectedTemplateSource) }}</p>
          <p v-if="OutputType === 'egern'">
            自动更新：每 {{ EgernUpdateInterval }} 分钟
          </p>
        </div>
        <div class="summary-block">
          <strong>连接选项</strong>
          <p>
            {{ checkList.includes("udp") ? "启用 UDP" : "未启用 UDP" }}，{{
              checkList.includes("cert") ? "跳过证书验证" : "不跳过证书验证"
            }}
          </p>
        </div>
        <div class="summary-block">
          <strong>节点顺序</strong>
          <p>{{ selectedNodePreview }}</p>
        </div>
        <div class="summary-block">
          <strong>策略组分配</strong>
          <p>读取模板：{{ templateDisplayName(groupNodesTemplate) }}</p>
          <p>{{ selectedGroupSummary }}</p>
        </div>
      </section>

      <template #footer>
        <div class="wizard-footer">
          <el-button @click="dialogVisible = false">取消</el-button>
          <div class="wizard-navigation">
            <el-button v-if="wizardStep > 0" @click="prevStep"
              >上一步</el-button
            >
            <el-button v-if="wizardStep < 4" type="primary" @click="nextStep"
              >下一步</el-button
            >
            <el-button v-else type="primary" @click="addSubs"
              >保存订阅</el-button
            >
          </div>
        </div>
      </template>
    </el-dialog>

    <div class="page-heading">
      <div>
        <h1>订阅列表</h1>
        <p>管理订阅地址、客户端入口和访问记录</p>
      </div>
      <div class="heading-actions">
        <el-button
          v-if="!isMobile"
          :type="subscriptionSortMode ? 'success' : undefined"
          @click="subscriptionSortMode = !subscriptionSortMode"
        >
          {{ subscriptionSortMode ? "完成排序" : "排序" }}
        </el-button>
        <el-button type="primary" @click="handleAddSub">添加订阅</el-button>
      </div>
    </div>

    <section class="work-surface mobile-app-surface">
      <div class="table-toolbar">
        <span class="record-count">共 {{ tableData.length }} 条订阅</span>
      </div>

      <el-table
        class="desktop-data-table"
        ref="table"
        :data="currentTableData"
        row-key="ID"
        :tree-props="{ children: 'Nodes' }"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" fixed width="48" />
        <el-table-column v-if="subscriptionSortMode" width="42" label="">
          <template #default>
            <span class="row-drag-handle" title="拖动排序">☰</span>
          </template>
        </el-table-column>
        <el-table-column prop="Name" label="订阅名称 / 节点" min-width="220">
          <template #default="{ row }">
            <span class="primary-cell">{{ row.Name }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="Link" label="客户端" min-width="160">
          <template #default="{ row }">
            <el-button
              v-if="row.Nodes"
              link
              type="primary"
              @click="handleClient(row)"
            >
              查看客户端
            </el-button>
            <span v-else class="muted-cell">节点</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <template v-if="row.Nodes">
              <el-tag v-if="row.Revoked" type="danger" effect="plain"
                >已失效</el-tag
              >
              <el-tag
                v-else-if="
                  row.ExpireAt && beijingTimestamp(row.ExpireAt) < Date.now()
                "
                type="warning"
                effect="plain"
              >
                已过期
              </el-tag>
              <el-tag v-else type="success" effect="plain">有效</el-tag>
            </template>
            <span v-else class="muted-cell">节点</span>
          </template>
        </el-table-column>
        <el-table-column label="访问" width="110">
          <template #default="{ row }">
            <span v-if="row.Nodes">
              {{ row.AccessCount || 0 }}/{{ row.AccessLimit || "不限" }}
            </span>
            <span v-else class="muted-cell">--</span>
          </template>
        </el-table-column>
        <el-table-column
          prop="CreatedAt"
          label="创建时间"
          min-width="180"
          sortable
          :formatter="formatCreatedAt"
        />
        <el-table-column label="操作" width="320" align="center">
          <template #default="scope">
            <div v-if="scope.row.Nodes" class="subscription-action-grid">
              <el-button link @click="handleIplogs(scope.row)">记录</el-button>
              <el-button
                link
                type="primary"
                @click="handlePreviewSub(scope.row)"
                >查看文件</el-button
              >
              <el-button link @click="handleResetToken(scope.row)"
                >重置 token</el-button
              >
              <el-button link @click="handleToggleRevoked(scope.row)">
                {{ scope.row.Revoked ? "恢复" : "失效" }}
              </el-button>
              <el-button link type="primary" @click="handleEdit(scope.row)"
                >编辑</el-button
              >
              <el-button link type="danger" @click="handleDel(scope.row)"
                >删除</el-button
              >
            </div>
            <el-button v-else link type="primary" @click="copyInfo(scope.row)">
              复制
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="mobile-only-list mobile-card-list">
        <div v-if="currentTableData.length === 0" class="mobile-empty-state">
          暂无订阅
        </div>
        <article
          v-for="row in currentTableData"
          :key="row.ID"
          class="mobile-card"
          :class="{ 'is-muted': row.Revoked || isSubExpired(row) }"
        >
          <div class="mobile-card-top">
            <el-checkbox
              :model-value="isSubSelected(row)"
              @change="
                (checked) => toggleMobileSubSelection(row, Boolean(checked))
              "
            />
            <div class="mobile-card-title">
              <strong>{{ row.Name }}</strong>
              <small>{{ formatCreatedAt(row) }}</small>
            </div>
            <span class="mobile-status" :class="subStatusClass(row)">
              {{ subStatusText(row) }}
            </span>
          </div>

          <div class="mobile-fields">
            <div class="mobile-field">
              <span>节点</span>
              <strong>{{ subNodeSummary(row) }}</strong>
            </div>
            <div class="mobile-field">
              <span>访问</span>
              <strong
                >{{ row.AccessCount || 0 }}/{{
                  row.AccessLimit || "不限"
                }}</strong
              >
            </div>
          </div>

          <div class="mobile-card-actions">
            <el-button type="primary" @click="handleClient(row)"
              >客户端</el-button
            >
            <el-button type="primary" plain @click="handlePreviewSub(row)"
              >查看文件</el-button
            >
            <el-button @click="handleIplogs(row)">记录</el-button>
            <el-button type="warning" @click="handleResetToken(row)">
              重置
            </el-button>
            <el-button @click="handleToggleRevoked(row)">
              {{ row.Revoked ? "恢复" : "失效" }}
            </el-button>
            <el-button type="primary" @click="handleEdit(row)">编辑</el-button>
            <el-button type="danger" @click="handleDel(row)">删除</el-button>
          </div>
        </article>
      </div>

      <div class="table-footer">
        <div class="batch-actions">
          <el-button @click="selectAll()">全选</el-button>
          <el-button @click="toggleSelection()">取消选择</el-button>
          <el-button type="danger" plain @click="selectDel">批量删除</el-button>
        </div>
        <el-pagination
          class="table-pagination"
          :current-page="currentPage"
          :page-size="pageSize"
          layout="total, sizes, prev, pager, next, jumper"
          :page-sizes="[10, 20, 30, 40]"
          :total="tableData.length"
          @size-change="handleSizeChange"
          @current-change="handleCurrentChange"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.subscription-action-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 2px 8px;
  align-items: center;
}

.subscription-action-grid .el-button {
  min-height: 24px;
  margin-left: 0;
}

.record-count,
.muted-cell {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.primary-cell {
  color: var(--el-text-color-primary);
  font-weight: 550;
}

.dialog-heading h2 {
  margin: 0;
  color: var(--el-text-color-primary);
  font-size: 20px;
}

.dialog-heading p,
.dialog-intro,
.panel-copy p {
  margin: 6px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.wizard-steps {
  margin-bottom: 18px;
  border-radius: 10px;
}

.mobile-wizard-status {
  display: none;
}

.wizard-panel {
  min-height: 470px;
  padding: 18px 2px 4px;
}

.panel-copy {
  margin-bottom: 18px;
}

.panel-copy h3 {
  margin: 0;
  color: var(--el-text-color-primary);
  font-size: 17px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.field {
  display: grid;
  gap: 8px;
}

.field-full {
  grid-column: 1 / -1;
}

.field-label {
  color: var(--el-text-color-primary);
  font-size: 13px;
  font-weight: 650;
}

.field-hint {
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}

.template-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}

.template-card,
.summary-card,
.summary-block {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  background: var(--el-fill-color-extra-light);
}

.template-card {
  display: grid;
  gap: 14px;
  padding: 16px;
}

.template-card-head,
.node-column-head,
.client-card-title,
.client-actions,
.wizard-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.option-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.node-picker {
  display: grid;
  grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr);
  gap: 14px;
}

.manual-group-bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  margin-bottom: 12px;
}

.group-template-source {
  margin-bottom: 12px;
}

.group-template-source small {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.group-rule-list {
  display: grid;
  max-height: 390px;
  gap: 10px;
  overflow: auto;
  padding-right: 4px;
}

.group-rule-card {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) auto minmax(240px, 0.9fr);
  gap: 12px;
  align-items: center;
  padding: 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.group-rule-main {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.group-rule-main strong {
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-rule-main small {
  color: var(--el-text-color-secondary);
}

.group-reset-button {
  justify-self: start;
  min-height: 20px;
  padding: 0;
}

.group-mode {
  white-space: nowrap;
}

.mobile-node-choice-list {
  display: grid;
  max-height: 280px;
  gap: 8px;
  overflow-y: auto;
}

.mobile-node-choice {
  display: flex;
  min-height: 46px;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  cursor: pointer;
}

.mobile-node-choice.is-selected {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.mobile-node-choice input {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  margin: 0;
  accent-color: var(--el-color-primary);
}

.mobile-node-choice span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.node-column {
  min-height: 390px;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.node-column-head {
  min-height: 48px;
  padding: 0 14px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-extra-light);
}

.node-column-head small {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-weight: 400;
}

.selected-node-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.selected-node-actions .el-button {
  margin-left: 0;
}

.node-search {
  padding: 12px;
}

.node-list,
.selected-nodes {
  max-height: 300px;
  overflow: auto;
}

.node-option {
  display: flex;
  width: 100%;
  min-height: 42px;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  border: 0;
  border-top: 1px solid var(--el-border-color-lighter);
  background: transparent;
  color: var(--el-text-color-primary);
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.node-option:hover {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.node-empty,
.empty-selection {
  margin: 14px;
  padding: 22px;
  border: 1px dashed var(--el-border-color);
  border-radius: 10px;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-placeholder);
  font-size: 13px;
  text-align: center;
}

.draggable-item {
  display: grid;
  grid-template-columns: 18px 30px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  min-height: 44px;
  padding: 0 12px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
  cursor: grab;
}

.draggable-item:hover {
  background: var(--el-fill-color-light);
}

.disabled-selected-nodes {
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-extra-light);
}

.disabled-selected-head {
  padding: 9px 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.disabled-selected-item {
  display: grid;
  grid-template-columns: 22px 30px minmax(0, 1fr) auto auto auto;
  gap: 8px;
  align-items: center;
  min-height: 44px;
  padding: 0 12px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: color-mix(
    in srgb,
    var(--el-fill-color-light) 62%,
    var(--el-bg-color)
  );
  color: var(--el-text-color-secondary);
}

.disabled-selected-item .node-name {
  color: var(--el-text-color-secondary);
  text-decoration: line-through;
}

.disabled-selected-item .el-button {
  margin-left: 0;
}

.drag-lock {
  color: var(--el-text-color-placeholder);
  font-size: 12px;
}

.ghost {
  opacity: 0.45;
  background: var(--el-color-primary-light-9);
}

.row-number {
  color: var(--el-text-color-placeholder);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.drag-handle {
  color: var(--el-text-color-placeholder);
  letter-spacing: -3px;
}

.node-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wizard-navigation {
  display: flex;
  gap: 10px;
}

.wizard-navigation :deep(.el-button + .el-button) {
  margin-left: 0;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}

.summary-card {
  display: grid;
  gap: 8px;
  padding: 14px;
}

.summary-card span,
.summary-block p {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.summary-card strong,
.summary-block strong {
  color: var(--el-text-color-primary);
}

.summary-block {
  padding: 14px;
  margin-top: 12px;
}

.summary-block p {
  margin: 8px 0 0;
  word-break: break-all;
}

.qr-content {
  display: grid;
  gap: 16px;
}

.qr-frame {
  display: grid;
  width: 228px;
  height: 228px;
  margin: 0 auto;
  place-items: center;
  border: 1px solid var(--el-border-color-lighter);
  background: #fff;
}

.client-dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.client-dialog-head .dialog-intro {
  margin-bottom: 4px;
}

.client-card-list {
  display: grid;
  gap: 12px;
  margin-top: 16px;
}

.client-card {
  padding: 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-extra-light);
}

.client-card-title span {
  color: var(--el-text-color-primary);
  font-weight: 650;
}

.client-card p {
  margin: 7px 0 10px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.client-url-input {
  margin-bottom: 10px;
}

.client-actions {
  flex-wrap: wrap;
  justify-content: flex-start;
}

.subscription-preview {
  display: grid;
  max-height: calc(100dvh - 220px);
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 14px;
}

:deep(.subscription-preview-dialog .el-dialog__body) {
  overflow: hidden;
}

.preview-head {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.preview-head strong {
  color: var(--el-text-color-primary);
}

.preview-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.preview-code {
  min-height: 0;
  overflow: auto;
  padding: 16px;
  margin: 0;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  background: var(--el-fill-color-extra-light);
  color: var(--el-text-color-primary);
  font-size: 12px;
  line-height: 1.65;
  white-space: pre;
  scrollbar-gutter: stable;
}

@media (max-width: 860px) {
  .form-grid,
  .template-grid,
  .node-picker,
  .group-rule-card,
  .summary-grid {
    grid-template-columns: 1fr;
  }

  .manual-group-bar {
    grid-template-columns: 1fr;
  }

  .group-rule-list {
    max-height: none;
  }

  .wizard-panel {
    min-height: auto;
  }

  .node-column {
    min-height: 300px;
  }

  .client-dialog-head,
  .client-card-title {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 640px) {
  :deep(.subscription-wizard-dialog) {
    width: min(92vw, 520px) !important;
  }

  :deep(.subscription-wizard-dialog .el-dialog__body) {
    padding: 14px 12px;
  }

  :deep(.subscription-wizard-dialog .el-dialog__footer) {
    padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
  }

  .wizard-steps {
    display: none;
  }

  .mobile-wizard-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    margin-bottom: 12px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 10px;
    background: var(--el-fill-color-extra-light);
  }

  .mobile-wizard-status span {
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .mobile-wizard-status strong {
    color: var(--el-text-color-primary);
    font-size: 13px;
  }

  .wizard-panel {
    padding-top: 12px;
  }

  .panel-copy {
    margin-bottom: 12px;
  }

  .template-card,
  .summary-card,
  .summary-block {
    border-radius: 10px;
  }

  .template-card-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .selected-node-actions {
    flex-wrap: wrap;
  }

  .disabled-selected-item {
    grid-template-columns: 22px 24px minmax(0, 1fr) auto;
    padding: 8px 10px;
  }

  .disabled-selected-item .el-tag {
    grid-column: 3;
    justify-self: start;
  }

  .disabled-selected-item .el-button {
    padding: 0;
  }

  .group-rule-card {
    gap: 14px;
    padding: 14px;
  }

  .group-rule-main {
    gap: 6px;
  }

  .group-rule-main strong {
    font-size: 15px;
  }

  .group-reset-button {
    min-height: 36px;
  }

  .group-mode {
    display: grid;
    width: 100%;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    white-space: normal;
  }

  :deep(.group-mode .el-radio-button) {
    width: 100%;
  }

  :deep(.group-mode .el-radio-button__inner) {
    display: flex;
    width: 100%;
    min-height: 42px;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
  }

  .node-column {
    min-height: auto;
  }

  .node-picker {
    gap: 18px;
  }

  .node-column-head {
    min-height: 54px;
    padding: 0 12px;
  }

  .node-column-head :deep(.el-button) {
    min-height: 40px;
    padding: 0 8px;
  }

  .node-list {
    max-height: min(38vh, 300px);
  }

  .selected-nodes {
    max-height: min(48vh, 380px);
  }

  .draggable-item {
    grid-template-columns: 24px 24px minmax(0, 1fr) auto;
    gap: 8px;
    min-height: 58px;
    padding: 6px 10px;
  }

  .draggable-item .el-button {
    min-width: 52px;
    min-height: 40px;
    justify-self: end;
    padding: 0 8px;
  }

  .drag-handle {
    font-size: 16px;
  }

  .node-name {
    font-size: 14px;
  }

  .option-list {
    display: grid;
    grid-template-columns: 1fr;
  }

  .option-list :deep(.el-checkbox) {
    width: 100%;
    min-height: 44px;
    margin-right: 0;
  }

  .wizard-footer {
    align-items: stretch;
    flex-direction: column-reverse;
    gap: 12px;
  }

  .wizard-footer > :deep(.el-button) {
    width: 100%;
    min-height: 44px;
    margin-left: 0;
  }

  .wizard-navigation {
    width: 100%;
    gap: 10px;
  }

  .wizard-navigation :deep(.el-button) {
    min-width: 0;
    min-height: 44px;
    flex: 1 1 0;
    margin-left: 0;
  }

  .client-dialog-head {
    gap: 10px;
  }

  .client-actions {
    display: grid;
    width: 100%;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  :deep(.client-actions .el-button) {
    width: 100%;
    min-width: 0;
    min-height: 40px;
    margin-left: 0;
  }

  .preview-head {
    flex-direction: column;
  }

  .preview-meta {
    justify-content: flex-start;
  }

  .preview-code {
    padding: 12px;
    font-size: 11px;
  }

  .client-card {
    padding: 12px;
  }
}
</style>
