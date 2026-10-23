<script setup lang="ts">
import {
  ref,
  shallowRef,
  onMounted,
  onBeforeUnmount,
  nextTick,
  computed,
  watch,
} from "vue";
import {
  getNodes,
  exportNodes,
  importNodes,
  AddNodes,
  DelNode,
  UpdateNode,
  GetGroup,
  SetGroup,
  setNodeDisabled,
} from "@/api/subcription/node";
import {
  addIPEntry,
  deleteIPEntry,
  getIPEntries,
  IPEntry,
  NodeReplacementPreview,
  previewNodeReplacement,
  updateIPEntry,
} from "@/api/subcription/ip-library";
import { getSubs } from "@/api/subcription/subs";
import { formatBeijingTime } from "@/utils/time";
import { useDraggableTableRows } from "@/utils/table-drag";
import { useAppStore } from "@/store";
import { DeviceEnum } from "@/enums/DeviceEnum";

interface GroupNode {
  ID: number;
  Name: string;
  Nodes: Node[];
}
interface Node {
  ID: number;
  Name: string;
  Link: string;
  Disabled?: boolean;
  CreateDate: string;
  GroupNodes?: GroupNode[]; // 分组信息
}
interface NodeInfo {
  ID?: number; // 编辑时需要传入ID
  Title?: string;
  Name?: string;
  Link: string;
  GroupName?: string[]; // 分组名称
}
interface SubscriptionSummary {
  ID: number;
  Name: string;
  Revoked?: boolean;
  Nodes?: Array<{ ID: number }>;
}
onMounted(async () => {
  await refreshNodePageData();
});
const dialogMode = ref<"add" | "edit">("add");
const appStore = useAppStore();
const isMobile = computed(() => appStore.device === DeviceEnum.MOBILE);
const IPLibrarydialog = ref(false);
const ipEntries = ref<IPEntry[]>([]);
const ipEntriesLoading = ref(false);
const ipSaving = ref(false);
const ipForm = ref<{ ID?: number; Alias: string; Address: string }>({
  Alias: "",
  Address: "",
});
const replaceIPEnabled = ref(false);
const selectedIPEntryID = ref<number>();
const ipEntrySelectRef = ref<{ blur: () => void }>();
const subscriptionSelectRef = ref<{ blur: () => void }>();
const replacementPreview = ref<NodeReplacementPreview>();
const replacementLoading = ref(false);
const replacementError = ref("");
const allSubscriptions = ref<SubscriptionSummary[]>([]);
const selectedSubscriptionIDs = ref<number[]>([]);
const subscriptionsLoading = ref(false);
const subscriptionsLoadError = ref(false);
let latestSubscriptionRequest = 0;
let replacementTimer: ReturnType<typeof setTimeout> | undefined;
let replacementRequestID = 0;

// --- 表格选择与操作相关数据 ---
const multipleSelection = ref<Node[]>([]); // Stores selected table items
const multipleTable = ref<any>(null);
const nodeSortMode = ref(false);

const tableRefs = ref<{ [key: string]: any }>({}); // Stores references to each el-table
// --- 表格选择与操作相关数据结束 ---
// const NodeNewLinkInput = ref("")
// const NodeNewNameInput = ref("")
const NodeGroupInput = ref("");
const tableData = shallowRef<Node[]>([]);
const currentPage = ref(1);
const pageSize = ref(20);
const totalNodes = ref(0);
const totalAllNodes = ref(0);
const tableLoading = ref(false);
const nodeImportInput = ref<HTMLInputElement>();
const nodeImporting = ref(false);
let latestNodeRequest = 0;
// 分组列表临时存放数据
const activeName = ref("全部");
const Nodedialog = ref(false); // 弹窗是否可见
const Groupdialog = ref(false); // 弹窗是否可见
const NodeForm = ref<NodeInfo>({
  Title: "",
  Name: "",
  Link: "",
  GroupName: [],
});
const allGroupNames = ref<string[]>([]); // 所有分组名称
const nodelistShow = ref(false); // 节点列表
const SelectionNodeGroups = ref<string[]>([]); // 选中的分组
const groupSelectRef = ref<any>();
const SelectionNode = ref(""); // 选中的节点

// const SelectionNodes = ref([]); // 选中的节点
const RadioGroup = ref("1"); // 分组单选框
const parsedAddLinks = computed(() =>
  NodeForm.value.Link.trim()
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item)
);
const replacementLinkSupported = computed(() => {
  if (parsedAddLinks.value.length !== 1) return false;
  return /^(ss|vless):\/\//i.test(parsedAddLinks.value[0]);
});
const inferredAddNames = computed(() =>
  parsedAddLinks.value.map((link) => extractNodeRemark(link))
);
const pagedTableData = computed(() => tableData.value);
const selectedNodeIds = computed(
  () => new Set(multipleSelection.value.map((item) => item.ID))
);
useDraggableTableRows({
  tableRef: multipleTable,
  rows: tableData,
  enabled: computed(() => nodeSortMode.value && !isMobile.value),
  storageKey: () =>
    `sublink:nodes:order:${activeName.value}:${pageSize.value}:${currentPage.value}`,
  rowKey: (row) => row.ID,
});

function decodeBase64Text(text: string) {
  try {
    const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
    const padding =
      normalized.length % 4 ? "=".repeat(4 - (normalized.length % 4)) : "";
    const binary = window.atob(normalized + padding);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function extractNodeRemark(link: string) {
  const trimmed = link.trim();
  if (!trimmed) return "";
  try {
    if (trimmed.startsWith("vmess://")) {
      const raw = decodeBase64Text(trimmed.replace("vmess://", ""));
      const data = JSON.parse(raw);
      return data.ps || "";
    }
    const parsed = new URL(trimmed);
    return decodeURIComponent(parsed.hash.replace(/^#/, ""));
  } catch {
    return "";
  }
}

// 将所有输入的值清空
function ClearInput() {
  SelectionNode.value = ""; // 清空选中的节点
  NodeForm.value = {
    // 清空节点链接输入框
    Title: "",
    Name: "",
    Link: "",
    GroupName: [],
  };
  NodeGroupInput.value = ""; // 清空创建分组输入框
  SelectionNodeGroups.value = []; // 清空选中的分组
  selectedSubscriptionIDs.value = [];
  subscriptionsLoadError.value = false;
  nodelistShow.value = false; // 隐藏节点列表
  Nodedialog.value = false; // 关闭节点添加弹窗
  Groupdialog.value = false; // 关闭分组绑定弹窗
  resetReplacement();
}
async function getnodes() {
  const requestId = ++latestNodeRequest;
  tableLoading.value = true;
  try {
    const { data } = await getNodes({
      page: currentPage.value,
      page_size: pageSize.value,
      group: activeName.value === "全部" ? "" : activeName.value,
    });
    if (requestId !== latestNodeRequest) return;
    if (Array.isArray(data)) {
      tableData.value = data;
      totalNodes.value = data.length;
      return;
    }
    tableData.value = Array.isArray(data?.items) ? data.items : [];
    totalNodes.value = Number(data?.total || 0);
    if (activeName.value === "全部") {
      totalAllNodes.value = totalNodes.value;
    }
    clampCurrentPage();
  } finally {
    if (requestId === latestNodeRequest) {
      tableLoading.value = false;
    }
  }
}
async function GetGroups() {
  const { data } = await GetGroup();
  allGroupNames.value = Array.isArray(data) ? data : [];
  RadioGroup.value = allGroupNames.value.length > 0 ? "1" : "2"; // 自动选择单选框值
  // console.log("单选框",RadioGroup.value);
}

async function loadNodeSubscriptions(nodeID?: number) {
  const requestID = ++latestSubscriptionRequest;
  subscriptionsLoading.value = true;
  subscriptionsLoadError.value = false;
  selectedSubscriptionIDs.value = [];
  try {
    const { data } = await getSubs();
    if (requestID !== latestSubscriptionRequest) return;
    allSubscriptions.value = Array.isArray(data) ? data : [];
    if (nodeID) {
      selectedSubscriptionIDs.value = allSubscriptions.value
        .filter((sub) => sub.Nodes?.some((node) => node.ID === nodeID))
        .map((sub) => sub.ID);
    }
  } catch {
    if (requestID !== latestSubscriptionRequest) return;
    allSubscriptions.value = [];
    subscriptionsLoadError.value = true;
    ElMessage.error("订阅列表加载失败，请稍后重试");
  } finally {
    if (requestID === latestSubscriptionRequest) {
      subscriptionsLoading.value = false;
    }
  }
}

async function loadIPEntries() {
  ipEntriesLoading.value = true;
  try {
    const { data } = await getIPEntries();
    ipEntries.value = Array.isArray(data) ? data : [];
    if (
      selectedIPEntryID.value &&
      !ipEntries.value.some((item) => item.ID === selectedIPEntryID.value)
    ) {
      selectedIPEntryID.value = undefined;
    }
  } finally {
    ipEntriesLoading.value = false;
  }
}

async function refreshNodePageData() {
  await Promise.all([getnodes(), GetGroups(), loadIPEntries()]);
}

function resetReplacement() {
  replaceIPEnabled.value = false;
  selectedIPEntryID.value = undefined;
  replacementPreview.value = undefined;
  replacementError.value = "";
  replacementLoading.value = false;
  replacementRequestID += 1;
  if (replacementTimer) clearTimeout(replacementTimer);
}

function scheduleReplacementPreview() {
  if (replacementTimer) clearTimeout(replacementTimer);
  replacementPreview.value = undefined;
  replacementError.value = "";
  replacementRequestID += 1;
  const requestID = replacementRequestID;

  if (!replaceIPEnabled.value) {
    replacementLoading.value = false;
    return;
  }
  if (parsedAddLinks.value.length !== 1) {
    replacementLoading.value = false;
    replacementError.value = "IP 替换仅支持单条节点链接";
    return;
  }
  if (!replacementLinkSupported.value) {
    replacementLoading.value = false;
    replacementError.value = "IP 替换仅支持 SS 和 VLESS 链接";
    return;
  }
  if (!selectedIPEntryID.value) {
    replacementLoading.value = false;
    return;
  }

  replacementLoading.value = true;
  replacementTimer = setTimeout(async () => {
    try {
      const { data } = await previewNodeReplacement({
        link: parsedAddLinks.value[0],
        replace_ip_id: selectedIPEntryID.value!,
      });
      if (requestID !== replacementRequestID) return;
      replacementPreview.value = data;
    } catch (error: any) {
      if (requestID !== replacementRequestID) return;
      replacementError.value =
        error?.response?.data?.msg || "节点链接解析失败，请检查原始链接";
    } finally {
      if (requestID === replacementRequestID) {
        replacementLoading.value = false;
      }
    }
  }, 280);
}

async function handleReplacementSwitch() {
  if (!replaceIPEnabled.value) return;
  if (ipEntries.value.length === 0) {
    replaceIPEnabled.value = false;
    ElMessage.warning("请先向 IP 库添加入口 IP");
    await openIPLibrary();
  }
}

async function openIPLibrary() {
  IPLibrarydialog.value = true;
  resetIPForm();
  await loadIPEntries();
}

function resetIPForm() {
  ipForm.value = { Alias: "", Address: "" };
}

function editIPEntry(entry: IPEntry | Record<PropertyKey, unknown>) {
  const typedEntry = entry as IPEntry;
  ipForm.value = {
    ID: typedEntry.ID,
    Alias: typedEntry.Alias,
    Address: typedEntry.Address,
  };
}

async function saveIPEntry() {
  const alias = ipForm.value.Alias.trim();
  const address = ipForm.value.Address.trim();
  if (!alias || !address) {
    ElMessage.warning("请填写 IP 和别名");
    return;
  }
  ipSaving.value = true;
  try {
    if (ipForm.value.ID) {
      await updateIPEntry({ id: ipForm.value.ID, alias, address });
      ElMessage.success("IP 已更新");
    } else {
      await addIPEntry({ alias, address });
      ElMessage.success("IP 已加入库");
    }
    resetIPForm();
    await loadIPEntries();
    scheduleReplacementPreview();
  } finally {
    ipSaving.value = false;
  }
}

async function removeIPEntry(entry: IPEntry | Record<PropertyKey, unknown>) {
  const typedEntry = entry as IPEntry;
  try {
    await ElMessageBox.confirm(
      `确定从 IP 库删除“${typedEntry.Alias} · ${typedEntry.Address}”吗？已保存节点不会改变。`,
      "删除 IP",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
    );
    await deleteIPEntry(typedEntry.ID);
    ElMessage.success("IP 已删除");
    await loadIPEntries();
    scheduleReplacementPreview();
  } catch {
    // 用户取消时保持当前内容。
  }
}

function clampCurrentPage() {
  const maxPage = Math.max(1, Math.ceil(totalNodes.value / pageSize.value));
  if (currentPage.value > maxPage) {
    currentPage.value = maxPage;
  }
}

async function refreshFirstPage() {
  if (currentPage.value !== 1) {
    currentPage.value = 1;
    return;
  }
  await refreshNodePageData();
}

const handleAddNode = async () => {
  resetReplacement();
  const defaultGroups =
    activeName.value !== "全部" &&
    allGroupNames.value.includes(activeName.value)
      ? [activeName.value]
      : [];
  dialogMode.value = "add";
  Nodedialog.value = true;
  RadioGroup.value = allGroupNames.value.length > 0 ? "1" : "2";
  NodeForm.value = {
    Title: "添加节点",
    Name: "",
    Link: "",
    GroupName: defaultGroups,
  };
  SelectionNodeGroups.value = defaultGroups;
  NodeGroupInput.value = "";
  await loadNodeSubscriptions();
};

const closeGroupSelect = () => {
  nextTick(() => groupSelectRef.value?.blur());
};

const closeIPEntrySelect = () => {
  nextTick(() => ipEntrySelectRef.value?.blur());
};

const closeSubscriptionSelect = () => {
  nextTick(() => subscriptionSelectRef.value?.blur());
};

const downloadNodeBackup = async () => {
  try {
    const response: any = await exportNodes();
    const blob = new Blob([response.data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `sublink-nodes-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    ElMessage.success("节点已导出");
  } catch {
    ElMessage.error("节点导出失败");
  }
};

const selectNodeBackup = () => {
  nodeImportInput.value?.click();
};

const uploadNodeBackup = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".json")) {
    ElMessage.warning("请选择节点导出的 JSON 文件");
    input.value = "";
    return;
  }

  nodeImporting.value = true;
  try {
    const formData = new FormData();
    formData.append("file", file);
    const { data } = await importNodes(formData);
    ElMessage.success(`导入完成：新增 ${data.created}，跳过 ${data.skipped}`);
    await refreshFirstPage();
  } catch {
    ElMessage.error("节点导入失败");
  } finally {
    nodeImporting.value = false;
    input.value = "";
  }
};

const handleEditNode = async (row: any) => {
  resetReplacement();
  // NodeNewNameInput.value = row.Name; // 编辑时使用原名称
  // NodeNewLinkInput.value = row.Link; // 编辑时使用原链接
  dialogMode.value = "edit";
  Nodedialog.value = true;
  NodeForm.value = {
    ID: row.ID,
    Title: "编辑节点",
    Name: row.Name,
    Link: row.Link,
    GroupName: (row.GroupNodes || []).map((g: GroupNode) => g.Name),
  };
  SelectionNodeGroups.value = NodeForm.value.GroupName || [];
  SelectionNode.value = row.Name;
  await loadNodeSubscriptions(row.ID);
};
const SubmitNodeForm = async (row: any) => {
  const isAdd = dialogMode.value === "add";
  const links = parsedAddLinks.value;
  if (isAdd && links.length === 0) {
    ElMessage.warning("节点链接不能为空");
    return;
  }
  if (isAdd && links.length > 1 && NodeForm.value.Name?.trim()) {
    ElMessage.warning("批量添加时请留空节点名称，每条链接会自动读取自己的注释");
    return;
  }
  if (replaceIPEnabled.value) {
    if (!selectedIPEntryID.value) {
      ElMessage.warning("请选择入口 IP");
      return;
    }
    if (
      replacementLoading.value ||
      replacementError.value ||
      !replacementPreview.value
    ) {
      ElMessage.warning("请等待节点链接解析成功后再保存");
      return;
    }
  }
  if (subscriptionsLoading.value || subscriptionsLoadError.value) {
    ElMessage.warning("请等待订阅列表加载成功后再保存");
    return;
  }

  try {
    if (isAdd) {
      for (const link of links) {
        await AddNodes({
          link,
          name: links.length === 1 ? NodeForm.value.Name?.trim() : "",
          ...(replaceIPEnabled.value
            ? { replace_ip_id: selectedIPEntryID.value }
            : {}),
          group:
            RadioGroup.value === "1"
              ? SelectionNodeGroups.value.join(",")
              : NodeGroupInput.value,
          subscription_ids: selectedSubscriptionIDs.value.join(","),
        });
      }
      ElMessage.success("节点添加成功");
    } else {
      await UpdateNode({
        id: NodeForm.value.ID,
        name: NodeForm.value.Name?.trim(), // 新名称
        link: NodeForm.value.Link.trim(), // 新链接
        ...(replaceIPEnabled.value
          ? { replace_ip_id: selectedIPEntryID.value }
          : {}),
        group:
          RadioGroup.value === "1"
            ? SelectionNodeGroups.value.join(",")
            : NodeGroupInput.value,
        subscription_ids: selectedSubscriptionIDs.value.join(","),
      });
      ElMessage.success("节点更新成功");
    }
  } catch (err) {
    ElMessage.error(`${isAdd ? "添加" : "更新"}失败`);
    return;
  }
  await refreshNodePageData();
  ClearInput();
};

// const AddNode = async() => {
//   // 多节点链接输入处理
//   let NodeLinkInputs = NodeNewLinkInput.value.trim().split(/[\n,]/); // 使用换行符或逗号分隔输入的节点链接
//   NodeLinkInputs = NodeLinkInputs.map((item) => item.trim()).filter((item) => item !== ''); // 去除空白和重复的链接
//   if (NodeNewLinkInput.value.trim() === '') {
//     ElMessage.warning('节点链接不能为空');
//     return;
//   }

//   try {
//     // 多节点同步循环添加节点
//     for(const link of NodeLinkInputs) {
//       if (link) {
//           const newNode = {
//           link: link.trim(), // 节点链接
//           group: SelectionNodeGroups.value.join(','), // 选中的分组
//           };
//           await AddNodes(newNode).then(() => {
//           ElMessage.success('节点添加成功');
//           Nodedialog.value = false; // 关闭弹窗
//           });
//       }
//     }
//     // getnodes(); // 刷新节点列表
//     // GetGroups(); // 刷新分组列表
//   } catch (error) {
//     console.error('添加节点失败:', error);
//     // ElMessage.error('添加节点失败，请稍后再试');
//   }
//   getnodes(); // 刷新节点列表
//   GetGroups(); // 刷新分组列表
//   ClearInput(); // 清空所有输入
// }
const AddGroup = async () => {
  try {
    if (RadioGroup.value === "1" && SelectionNodeGroups.value.length === 0) {
      ElMessage.warning("你还没有选择分组");
      return;
    }
    if (RadioGroup.value === "2" && NodeGroupInput.value.trim() === "") {
      ElMessage.warning("创建的分组名不能为空");
      return;
    }
    if (SelectionNode.value.length > 0) {
      // 如果没有选择节点
      const newNode = {
        name: SelectionNode.value, // 节点链接
        group:
          RadioGroup.value == "1"
            ? SelectionNodeGroups.value.join(",")
            : NodeGroupInput.value, // 条件选择已有节点|创建分组
      };
      await SetGroup(newNode).then(() => {
        ElMessage.success("分组绑定成功");
      });
    }
  } catch (error) {
    console.error("添加分组失败:", error);
    // ElMessage.error('添加分组失败');
  }
  await refreshNodePageData(); // 刷新节点和分组
  ClearInput(); // 清空所有输入
};
// 表格时间格式化
const Timeformatter = (row: any) => {
  return formatBeijingTime(row.CreatedAt);
};
// 选择已有节点显示所属分组
const handleShownodeGroupList = () => {
  // 显示这个节点关联的分组
  SelectionNodeGroups.value = [];
  tableData.value.forEach((item) => {
    if (
      item.Name === SelectionNode.value &&
      (item.GroupNodes?.length ?? 0) > 0
    ) {
      // console.log(`节点 ${nodeData} 的分组:`, item.GroupNodes);
      item.GroupNodes?.forEach((item) => {
        SelectionNodeGroups.value.push(item.Name); // 将分组名称添加到 SelectionNodeGroups 中
      });
    }
  });
};
// 表格所属分组格式化
const Groupformatter = (row: any, cellValue: any) => {
  const data = row.GroupNodes || [];
  if (!Array.isArray(data) || data.length === 0) {
    return "未分组"; // 如果没有分组，返回默认值
  }
  return data.map((group: any) => group.Name).join(", ");
};
// --- 复制链接 (保持不变) ---
const copyUrl = (url: string) => {
  if (navigator.clipboard) {
    navigator.clipboard
      .writeText(url)
      .then(() => {
        ElMessage.success("链接已复制到剪贴板！");
      })
      .catch((err) => {
        console.error("复制失败:", err);
        ElMessage.error("复制失败！请手动复制。");
      });
  } else {
    const textarea = document.createElement("textarea");
    textarea.value = url;
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      ElMessage.success("链接已复制到剪贴板！");
    } catch (err) {
      ElMessage.warning("复制失败！");
    } finally {
      document.body.removeChild(textarea);
    }
  }
};
// 复制表格节点信息
const copyInfo = (row: any) => {
  copyUrl(row.Link);
};
const handleDel = async (row: any) => {
  try {
    await ElMessageBox.confirm(`你是否要删除 ${row.Name} ?`, "提示", {
      confirmButtonText: "确定",
      cancelButtonText: "取消",
      type: "warning",
    });
    await DelNode({ id: row.ID });
    ElMessage.success("删除成功");
  } catch (error) {
    if (error !== "cancel") {
      console.error("删除失败:", error);
      ElMessage.error("删除失败！");
    }
  }
  // 刷新节点列表
  await refreshNodePageData(); // 刷新节点和分组
  ClearInput(); // 清空所有输入
};
const selectDel = async () => {
  if (multipleSelection.value.length === 0) {
    ElMessage.warning("请选择要删除的节点！");
    return;
  }
  try {
    await ElMessageBox.confirm(
      `你是否要删除选中的 ${multipleSelection.value.length} 条节点 ?`,
      "提示",
      {
        confirmButtonText: "确定",
        cancelButtonText: "取消",
        type: "warning",
      }
    );

    for (const item of multipleSelection.value) {
      await DelNode({ id: item.ID });
    }
    ElMessage.success("批量删除成功");
  } catch (error) {
    if (error !== "cancel") {
      console.error("批量删除失败:", error);
      ElMessage.error("批量删除失败！");
    }
  }
  // 刷新节点列表
  await refreshNodePageData();
};
// 全选
const selectAll = () => {
  if (isMobile.value) {
    multipleSelection.value = [...pagedTableData.value];
    return;
  }
  nextTick(() => {
    const table = multipleTable.value;
    if (table) {
      // 否则全选
      pagedTableData.value.forEach((row) => {
        table.toggleRowSelection(row, true);
      });
    }
  });
};
// 取消全选
const selectClear = () => {
  if (isMobile.value) {
    multipleSelection.value = [];
    return;
  }
  nextTick(() => {
    const table = multipleTable.value;
    if (table) {
      table.clearSelection();
    }
  });
};
// --- 表格选择操作 (保持不变) ---
const setTableRef = (el: any, name: string) => {
  if (el) {
    tableRefs.value[name] = el;
  } else {
    delete tableRefs.value[name];
  }
};
//批量复制
const selectCopy = async () => {
  if (multipleSelection.value.length === 0) {
    ElMessage.warning("请选择要复制的节点！");
    return;
  }
  try {
    copyUrl(multipleSelection.value.map((item) => item.Link).join("\n"));
  } catch (error) {
    if (error !== "cancel") {
      console.error("批量复制失败:", error);
      ElMessage.error("批量复制失败");
    }
  }
};

const toggleNodeDisabled = async (row: any) => {
  await setNodeDisabled({
    id: row.ID,
    disabled: !row.Disabled,
  });
  ElMessage.success(row.Disabled ? "节点已恢复" : "节点已禁用");
  await refreshNodePageData();
};
const handleSelectionChange = (val: Node[]) => {
  multipleSelection.value = val;
};

const isNodeSelected = (row: Node) => selectedNodeIds.value.has(row.ID);

const toggleMobileSelection = (row: Node, checked: boolean) => {
  if (checked) {
    if (!isNodeSelected(row)) {
      multipleSelection.value = [...multipleSelection.value, row];
    }
    return;
  }
  multipleSelection.value = multipleSelection.value.filter(
    (item) => item.ID !== row.ID
  );
};

watch(activeName, () => {
  refreshFirstPage();
});

watch(pageSize, () => {
  refreshFirstPage();
});

watch(currentPage, () => {
  getnodes();
});

watch(
  [() => NodeForm.value.Link, replaceIPEnabled, selectedIPEntryID],
  scheduleReplacementPreview
);

onBeforeUnmount(() => {
  if (replacementTimer) clearTimeout(replacementTimer);
  replacementRequestID += 1;
});
</script>

<template>
  <div class="page-workspace mobile-page">
    <el-dialog
      v-model="IPLibrarydialog"
      class="form-dialog ip-library-dialog"
      width="760px"
      destroy-on-close
    >
      <template #header>
        <div class="dialog-heading">
          <h2>IP 库</h2>
          <p>维护转发链路第一台机器的入口 IP；修改或删除不会影响已保存节点。</p>
        </div>
      </template>

      <div class="ip-library-content">
        <div class="ip-entry-form">
          <label class="field">
            <span class="field-label">IP 地址</span>
            <el-input
              v-model="ipForm.Address"
              placeholder="例如 198.51.100.24 或 2001:db8::18"
              autocomplete="off"
            />
          </label>
          <label class="field">
            <span class="field-label">别名</span>
            <el-input
              v-model="ipForm.Alias"
              maxlength="80"
              placeholder="例如：香港入口 A"
              autocomplete="off"
              @keyup.enter="saveIPEntry"
            />
          </label>
          <div class="ip-form-actions">
            <el-button v-if="ipForm.ID" @click="resetIPForm"
              >取消编辑</el-button
            >
            <el-button type="primary" :loading="ipSaving" @click="saveIPEntry">
              {{ ipForm.ID ? "保存修改" : "加入 IP 库" }}
            </el-button>
          </div>
        </div>

        <el-table
          v-loading="ipEntriesLoading"
          class="desktop-ip-table desktop-data-table"
          :data="ipEntries"
          empty-text="IP 库还是空的"
          row-key="ID"
        >
          <el-table-column prop="Alias" label="别名" min-width="150" />
          <el-table-column prop="Address" label="IP 地址" min-width="230">
            <template #default="{ row }">
              <code class="ip-address">{{ row.Address }}</code>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130" align="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="editIPEntry(row)"
                >编辑</el-button
              >
              <el-button link type="danger" @click="removeIPEntry(row)"
                >删除</el-button
              >
            </template>
          </el-table-column>
        </el-table>

        <div
          v-loading="ipEntriesLoading"
          class="mobile-ip-list mobile-only-list mobile-card-list"
        >
          <div v-if="ipEntries.length === 0" class="mobile-empty">
            IP 库还是空的
          </div>
          <article
            v-for="entry in ipEntries"
            :key="entry.ID"
            class="mobile-card ip-card"
          >
            <div class="ip-card-copy">
              <strong>{{ entry.Alias }}</strong>
              <code>{{ entry.Address }}</code>
            </div>
            <div class="ip-card-actions">
              <el-button size="small" @click="editIPEntry(entry)"
                >编辑</el-button
              >
              <el-button
                size="small"
                type="danger"
                plain
                @click="removeIPEntry(entry)"
              >
                删除
              </el-button>
            </div>
          </article>
        </div>
      </div>
    </el-dialog>

    <el-dialog
      v-model="Nodedialog"
      class="form-dialog node-dialog"
      width="680px"
      :close-on-click-modal="true"
      destroy-on-close
    >
      <template #header>
        <div class="dialog-heading">
          <h2>{{ NodeForm.Title }}</h2>
          <p>
            {{
              dialogMode === "add"
                ? "粘贴一个或多个节点链接，并为它们设置分组。"
                : "修改节点名称、链接与所属分组。"
            }}
          </p>
        </div>
      </template>

      <div class="dialog-form">
        <label class="field">
          <span class="field-label">节点名称</span>
          <el-input
            v-model="NodeForm.Name"
            :placeholder="
              dialogMode === 'add'
                ? '可选；留空则自动读取链接末尾注释'
                : '输入便于识别的节点名称'
            "
          />
          <span v-if="dialogMode === 'add'" class="field-help">
            单条链接可手动填写，例如
            po0-HKT；批量添加请留空，每条链接会使用自己的注释名。
          </span>
        </label>

        <label class="field">
          <span class="field-label">节点链接</span>
          <el-input
            v-model="NodeForm.Link"
            placeholder="支持粘贴一个或多个链接；多个链接请每行填写一个"
            type="textarea"
            :autosize="{ minRows: dialogMode === 'add' ? 5 : 3, maxRows: 10 }"
          />
          <span v-if="dialogMode === 'add'" class="field-help"
            >每行填写一个链接，每个链接会被分别创建为一个节点。</span
          >
        </label>

        <div class="ip-replacement-section">
          <div class="replacement-switch-row">
            <div class="replacement-switch-copy">
              <strong>替换入口 IP</strong>
              <span>仅替换 SS/VLESS 的服务器地址，其他内容保持原样</span>
            </div>
            <el-switch
              v-model="replaceIPEnabled"
              :disabled="!replacementLinkSupported && !replaceIPEnabled"
              inline-prompt
              active-text="开"
              inactive-text="关"
              @change="handleReplacementSwitch"
            />
          </div>

          <template v-if="replaceIPEnabled">
            <label class="field">
              <span class="field-label">选择入口 IP</span>
              <el-select
                ref="ipEntrySelectRef"
                v-model="selectedIPEntryID"
                class="field-control"
                filterable
                placeholder="选择 IP 库中的入口地址"
                :loading="ipEntriesLoading"
                @change="closeIPEntrySelect"
              >
                <el-option
                  v-for="entry in ipEntries"
                  :key="entry.ID"
                  :value="entry.ID"
                  :label="`${entry.Alias} · ${entry.Address}`"
                >
                  <div class="ip-option">
                    <span>{{ entry.Alias }}</span>
                    <code>{{ entry.Address }}</code>
                  </div>
                </el-option>
              </el-select>
              <button
                class="inline-manage-button"
                type="button"
                @click="openIPLibrary"
              >
                管理 IP 库
              </button>
            </label>

            <div v-if="selectedIPEntryID" class="replacement-arrow">
              <span></span>
              <strong v-if="replacementPreview">
                {{ replacementPreview.original_host }} →
                {{ replacementPreview.ip_entry.Address }}
              </strong>
              <strong v-else-if="replacementLoading">正在严格解析链接…</strong>
              <strong v-else>等待解析</strong>
              <span></span>
            </div>

            <label v-if="selectedIPEntryID" class="field">
              <span class="field-label">保存后的节点链接</span>
              <el-input
                :model-value="replacementPreview?.link || ''"
                type="textarea"
                :rows="3"
                readonly
                resize="vertical"
                :placeholder="
                  replacementLoading ? '正在生成…' : '解析成功后显示只读链接'
                "
              />
              <span v-if="replacementError" class="replacement-error">
                {{ replacementError }}
              </span>
              <span v-else class="field-help">
                只读结果会随上方原链接实时更新；修改备注或参数请返回原输入框。
              </span>
            </label>
          </template>
        </div>

        <div
          v-if="dialogMode === 'add' && parsedAddLinks.length > 0"
          class="node-import-preview"
        >
          <div class="preview-head">
            <strong>将创建 {{ parsedAddLinks.length }} 个节点</strong>
            <span>{{
              NodeForm.Name && parsedAddLinks.length === 1
                ? "使用手动节点名"
                : "留空名称时使用链接注释"
            }}</span>
          </div>
          <div class="preview-list">
            <span
              v-for="(link, index) in parsedAddLinks.slice(0, 4)"
              :key="`${link}-${index}`"
              class="preview-chip"
            >
              {{
                parsedAddLinks.length === 1 && NodeForm.Name
                  ? NodeForm.Name
                  : inferredAddNames[index] || "未识别名称"
              }}
            </span>
            <span v-if="parsedAddLinks.length > 4" class="preview-more">
              +{{ parsedAddLinks.length - 4 }}
            </span>
          </div>
        </div>

        <div class="field">
          <span class="field-label">所属分组</span>
          <el-radio-group v-model="RadioGroup" class="flat-segmented">
            <el-radio-button v-if="allGroupNames.length > 0" label="1"
              >选择已有分组</el-radio-button
            >
            <el-radio-button label="2">创建新分组</el-radio-button>
          </el-radio-group>
        </div>

        <label
          v-if="RadioGroup === '1' && allGroupNames.length > 0"
          class="field"
        >
          <span class="field-label">选择分组</span>
          <el-select
            ref="groupSelectRef"
            v-model="SelectionNodeGroups"
            multiple
            placeholder="可选择多个分组"
            class="field-control"
            @change="closeGroupSelect"
          >
            <el-option
              v-for="item in allGroupNames"
              :key="item"
              :label="item"
              :value="item"
            />
          </el-select>
        </label>

        <label v-if="RadioGroup === '2'" class="field">
          <span class="field-label">新分组名称</span>
          <el-input v-model="NodeGroupInput" placeholder="例如：香港节点" />
        </label>

        <label class="field">
          <span class="field-label">所属订阅</span>
          <el-select
            ref="subscriptionSelectRef"
            v-model="selectedSubscriptionIDs"
            multiple
            filterable
            class="field-control"
            placeholder="可选择多个订阅"
            :loading="subscriptionsLoading"
            :disabled="subscriptionsLoadError"
            @change="closeSubscriptionSelect"
          >
            <el-option
              v-for="sub in allSubscriptions"
              :key="sub.ID"
              :label="sub.Name"
              :value="sub.ID"
            >
              <div class="subscription-option">
                <span>{{ sub.Name }}</span>
                <el-tag
                  v-if="sub.Revoked"
                  size="small"
                  type="danger"
                  effect="plain"
                >
                  已失效
                </el-tag>
              </div>
            </el-option>
          </el-select>
          <span v-if="subscriptionsLoadError" class="replacement-error">
            订阅列表加载失败，请关闭弹窗后重试。
          </span>
          <span v-else class="field-help">
            当前已关联
            {{ selectedSubscriptionIDs.length }} 个订阅，可同时选择多个。
          </span>
        </label>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="Nodedialog = false">取消</el-button>
          <el-button
            type="primary"
            :loading="replacementLoading || subscriptionsLoading"
            @click="SubmitNodeForm"
          >
            {{ dialogMode === "add" ? "添加节点" : "保存修改" }}
          </el-button>
        </div>
      </template>
    </el-dialog>

    <div class="page-heading">
      <div>
        <h1>节点列表</h1>
        <p>管理代理节点和分组</p>
      </div>
      <div class="heading-actions">
        <input
          ref="nodeImportInput"
          class="node-import-input"
          type="file"
          accept="application/json,.json"
          @change="uploadNodeBackup"
        />
        <el-button @click="openIPLibrary">IP 库</el-button>
        <el-button :loading="nodeImporting" @click="selectNodeBackup"
          >导入节点</el-button
        >
        <el-button @click="downloadNodeBackup">导出节点</el-button>
        <el-button
          v-if="!isMobile"
          :type="nodeSortMode ? 'success' : undefined"
          @click="nodeSortMode = !nodeSortMode"
        >
          {{ nodeSortMode ? "完成排序" : "排序" }}
        </el-button>
        <el-button type="primary" @click="handleAddNode">添加节点</el-button>
      </div>
    </div>

    <section class="work-surface mobile-app-surface">
      <div class="node-filters">
        <el-tabs v-model="activeName">
          <el-tab-pane :label="`全部 ${totalAllNodes}`" name="全部" />
          <el-tab-pane
            v-for="item in allGroupNames"
            :key="item"
            :label="item"
            :name="item"
          />
        </el-tabs>
      </div>

      <el-table
        class="desktop-node-table desktop-data-table"
        ref="multipleTable"
        :data="pagedTableData"
        :empty-text="tableLoading ? '加载中...' : '暂无数据'"
        tooltip-effect="dark"
        row-key="ID"
        :tree-props="{ children: 'Nodes' }"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="48" />
        <el-table-column v-if="nodeSortMode" width="42" label="">
          <template #default>
            <span class="row-drag-handle" title="拖动排序">☰</span>
          </template>
        </el-table-column>
        <el-table-column type="index" width="56" label="#" />
        <el-table-column prop="Name" label="节点名称" min-width="130" sortable>
          <template #default="{ row }">
            <span
              class="primary-cell"
              :class="{ 'is-disabled-node': row.Disabled }"
            >
              {{ row.Name }}
            </span>
            <el-tag v-if="row.Disabled" size="small" type="info" effect="plain">
              已禁用
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column
          prop="Link"
          label="节点链接"
          min-width="320"
          show-overflow-tooltip
        >
          <template #default="{ row }">
            <code class="node-link" :title="row.Link">
              {{ row.Link }}
            </code>
          </template>
        </el-table-column>
        <el-table-column
          prop="CreatedAt"
          label="创建时间"
          min-width="150"
          :formatter="Timeformatter"
          sortable
          show-overflow-tooltip
        />
        <el-table-column
          label="所属分组"
          min-width="95"
          :formatter="Groupformatter"
          show-overflow-tooltip
        />
        <el-table-column label="操作" width="132" align="center" fixed="right">
          <template #default="scope">
            <div class="desktop-action-grid">
              <el-button link type="primary" @click="handleEditNode(scope.row)"
                >编辑</el-button
              >
              <el-button link @click="copyInfo(scope.row)">复制</el-button>
              <el-button link @click="toggleNodeDisabled(scope.row)">
                {{ scope.row.Disabled ? "恢复" : "禁用" }}
              </el-button>
              <el-button link type="danger" @click="handleDel(scope.row)"
                >删除</el-button
              >
            </div>
          </template>
        </el-table-column>
      </el-table>

      <div
        class="mobile-node-list mobile-only-list mobile-card-list"
        v-loading="tableLoading"
      >
        <div v-if="pagedTableData.length === 0" class="mobile-empty">
          {{ tableLoading ? "加载中..." : "暂无数据" }}
        </div>

        <article
          v-for="(row, index) in pagedTableData"
          :key="row.ID"
          class="node-card mobile-card"
          :class="{ 'is-disabled-card is-muted': row.Disabled }"
        >
          <div class="node-card-head mobile-card-top">
            <el-checkbox
              :model-value="isNodeSelected(row)"
              @change="
                (checked) => toggleMobileSelection(row, Boolean(checked))
              "
            />
            <div class="node-card-title mobile-card-title">
              <strong>{{ row.Name || `节点 ${index + 1}` }}</strong>
              <span>#{{ (currentPage - 1) * pageSize + index + 1 }}</span>
            </div>
            <span class="mobile-status" :class="{ 'is-danger': row.Disabled }">
              {{ row.Disabled ? "禁用" : "正常" }}
            </span>
          </div>

          <div class="mobile-fields">
            <div class="mobile-field">
              <span>分组</span>
              <strong>{{ Groupformatter(row, null) }}</strong>
            </div>
            <div class="mobile-field">
              <span>创建时间</span>
              <strong>{{ Timeformatter(row) }}</strong>
            </div>
            <div class="mobile-field">
              <span>节点链接</span>
              <code>{{ row.Link }}</code>
            </div>
          </div>

          <div class="node-card-actions mobile-card-actions">
            <el-button size="small" type="primary" @click="handleEditNode(row)">
              编辑
            </el-button>
            <el-button size="small" @click="copyInfo(row)">复制</el-button>
            <el-button size="small" @click="toggleNodeDisabled(row)">
              {{ row.Disabled ? "恢复" : "禁用" }}
            </el-button>
            <el-button size="small" type="danger" plain @click="handleDel(row)">
              删除
            </el-button>
          </div>
        </article>
      </div>

      <div class="table-footer">
        <div class="batch-actions">
          <el-button @click="selectAll">全选当前页</el-button>
          <el-button @click="selectClear">取消选择</el-button>
          <el-button type="primary" plain @click="selectCopy"
            >复制选中</el-button
          >
          <el-button type="danger" plain @click="selectDel">删除选中</el-button>
        </div>
        <div class="table-pagination">
          <span class="record-count">共 {{ totalNodes }} 个节点</span>
          <el-pagination
            v-model:current-page="currentPage"
            v-model:page-size="pageSize"
            layout="sizes, prev, pager, next"
            :page-sizes="[10, 20, 50, 100]"
            :total="totalNodes"
            background
            small
          />
        </div>
      </div>
    </section>
  </div>
</template>
<style scoped>
.field-control {
  width: 100%;
}

.ip-library-content {
  display: grid;
  gap: 18px;
}

.ip-entry-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 12px;
  align-items: end;
  padding: 14px;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.ip-form-actions,
.ip-card-actions {
  display: flex;
  gap: 8px;
}

.ip-form-actions .el-button + .el-button,
.ip-card-actions .el-button + .el-button {
  margin-left: 0;
}

.ip-address,
.ip-card-copy code,
.ip-option code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.mobile-ip-list {
  display: none;
}

.ip-card {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.ip-card-copy {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.ip-card-copy code {
  color: var(--el-text-color-secondary);
  overflow-wrap: anywhere;
}

.ip-replacement-section {
  display: grid;
  gap: 14px;
  padding: 14px;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.replacement-switch-row {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
}

.replacement-switch-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.replacement-switch-copy strong {
  font-size: 13px;
  color: var(--el-text-color-primary);
}

.replacement-switch-copy span {
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}

.ip-option,
.subscription-option {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
}

.ip-option code {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.inline-manage-button {
  justify-self: start;
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
  background: transparent;
  border: 0;
}

.replacement-arrow {
  display: grid;
  grid-template-columns: minmax(20px, 1fr) auto minmax(20px, 1fr);
  gap: 10px;
  align-items: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.replacement-arrow span {
  height: 1px;
  background: var(--el-border-color);
}

.replacement-arrow strong {
  font-weight: 600;
  color: var(--el-text-color-regular);
}

.replacement-error {
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-color-danger);
}

.node-filters {
  margin: -8px 0 12px;
}

.node-import-input {
  display: none;
}

.node-filters :deep(.el-tabs__header) {
  margin-bottom: 0;
}

.primary-cell {
  font-weight: 550;
}

.is-disabled-node {
  color: var(--el-text-color-placeholder);
  text-decoration: line-through;
}

.node-link {
  display: block;
  max-width: 100%;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  overflow-wrap: anywhere;
  white-space: normal;
  background: transparent;
}

@media (width <= 1280px) {
  .node-link {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.desktop-action-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 10px;
  justify-items: center;
}

.desktop-action-grid .el-button {
  min-height: 22px;
  margin-left: 0;
}

.node-import-preview {
  display: grid;
  gap: 10px;
  padding: 12px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.preview-head {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.preview-head strong {
  font-size: 13px;
  color: var(--el-text-color-primary);
}

.preview-head span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.preview-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.preview-chip,
.preview-more {
  max-width: 180px;
  padding: 5px 9px;
  overflow: hidden;
  font-size: 12px;
  color: var(--el-color-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
  background: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--el-color-primary) 28%, transparent);
  border-radius: 999px;
}

.record-count,
.muted-cell {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.table-pagination {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-left: auto;
}

.mobile-node-list {
  display: none;
}

@media (width <= 992px) {
  .page-heading {
    gap: 12px;
    align-items: flex-start;
  }

  .page-heading h1 {
    font-size: 21px;
  }

  .page-heading p {
    font-size: 13px;
  }

  .node-filters {
    margin: -4px 0 14px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .node-filters::-webkit-scrollbar {
    display: none;
  }

  .desktop-node-table {
    display: none;
  }

  .mobile-node-list {
    display: grid;
    gap: 10px;
    min-height: 120px;
  }

  .mobile-empty {
    display: grid;
    place-items: center;
    min-height: 120px;
    color: var(--el-text-color-secondary);
  }

  .node-card-head {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
  }

  .node-card-title {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .node-card-title strong {
    overflow: hidden;
    font-size: 15px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .node-card-title span,
  .node-card-meta {
    font-size: 12px;
  }

  .node-card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
  }

  .mobile-node-link {
    display: -webkit-box;
    max-height: 54px;
    padding: 8px;
    overflow: hidden;
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    line-height: 18px;
    color: var(--el-text-color-secondary);
    overflow-wrap: anywhere;
    background: var(--el-fill-color-light);
    border-radius: 6px;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
  }

  .node-card-actions {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
  }

  .node-card-actions .el-button {
    width: 100%;
    min-width: 0;
    margin-left: 0;
    border-radius: 7px;
  }

  .table-footer {
    position: sticky;
    bottom: calc(70px + env(safe-area-inset-bottom));
    z-index: 5;
    gap: 10px;
    padding: 10px;
    margin: 10px -2px -2px;
    background: color-mix(in srgb, var(--el-bg-color) 92%, transparent);
    backdrop-filter: blur(10px);
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 8px;
  }

  .batch-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    width: 100%;
  }

  .batch-actions .el-button {
    width: 100%;
    margin-left: 0;
  }

  .table-pagination {
    justify-content: space-between;
    width: 100%;
    margin-left: 0;
  }

  .record-count {
    flex: 0 0 auto;
  }

  :deep(.node-dialog) {
    display: flex;
    flex-direction: column;
  }

  :deep(.node-dialog .el-dialog__body) {
    flex: 1;
    min-height: 0;
    padding: 12px 16px;
    overflow-y: auto;
  }

  :deep(.node-dialog .el-dialog__footer) {
    padding: 10px 16px calc(14px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--el-border-color-lighter);
  }

  .dialog-footer {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .dialog-footer .el-button {
    width: 100%;
    margin-left: 0;
  }

  .ip-entry-form {
    grid-template-columns: 1fr;
    align-items: stretch;
  }

  .ip-form-actions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  }

  .ip-form-actions .el-button {
    width: 100%;
  }
}

@media (width <= 768px) {
  .desktop-ip-table {
    display: none;
  }

  .mobile-ip-list {
    display: grid;
  }

  .replacement-switch-row {
    align-items: flex-start;
  }

  :deep(.ip-library-dialog) {
    display: flex;
    flex-direction: column;
  }

  :deep(.ip-library-dialog .el-dialog__body) {
    flex: 1;
    min-height: 0;
    padding: 12px 16px;
    overflow-y: auto;
  }
}

@media (width <= 420px) {
  .page-heading {
    display: grid;
  }

  .page-heading .el-button {
    width: 100%;
  }

  .node-card-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .table-pagination {
    display: grid;
    justify-items: stretch;
  }

  .ip-card {
    grid-template-columns: 1fr;
  }

  .ip-card-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .ip-card-actions .el-button {
    width: 100%;
  }
}
</style>
