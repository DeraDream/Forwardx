<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import QrcodeVue from "qrcode.vue";
import { VueDraggable } from "vue-draggable-plus";
import {
  addNodeSubscription,
  deleteNodeSubscription,
  getNodeSubscriptions,
  resetNodeSubscriptionToken,
  setNodeSubscriptionRevoked,
  updateNodeSubscription,
} from "@/api/subcription/node-subscription";
import { getNodes } from "@/api/subcription/node";
import { beijingTimestamp, formatBeijingTime } from "@/utils/time";
import { useDraggableTableRows } from "@/utils/table-drag";
import { useAppStore } from "@/store";
import { DeviceEnum } from "@/enums/DeviceEnum";

interface Node {
  ID: number;
  Name: string;
  Link: string;
  Disabled?: boolean;
}

interface NodeSub {
  ID: number;
  Name: string;
  Nodes: Node[];
  Token: string;
  Revoked: boolean;
  ExpireAt?: string;
  AccessLimit: number;
  AccessCount: number;
  CreatedAt?: string;
}

const tableData = ref<NodeSub[]>([]);
const nodesList = ref<Node[]>([]);
const table = ref();
const appStore = useAppStore();
const isMobile = computed(() => appStore.device === DeviceEnum.MOBILE);
const multipleSelection = ref<NodeSub[]>([]);
const dialogVisible = ref(false);
const mode = ref<"add" | "edit">("add");
const subName = ref("");
const oldSubName = ref("");
const expireAt = ref("");
const accessLimit = ref<number | undefined>();
const selectedNodes = ref<number[]>([]);
const nodeKeyword = ref("");
const currentPage = ref(1);
const pageSize = ref(10);
const clientDialog = ref(false);
const clientSubName = ref("");
const clientUrl = ref("");
const qrDialog = ref(false);
const qrTitle = ref("");
const qrcode = ref("");

const dialogTitle = computed(() =>
  mode.value === "add" ? "添加节点订阅" : "编辑节点订阅"
);
const availableNodes = computed(() => {
  const keyword = nodeKeyword.value.trim().toLowerCase();
  return nodesList.value.filter((node) => {
    if (node.Disabled) return false;
    if (selectedNodes.value.includes(node.ID)) return false;
    return !keyword || node.Name.toLowerCase().includes(keyword);
  });
});
const selectedPreview = computed(() => {
  if (!selectedNodes.value.length) return "尚未选择节点";
  const head = selectedNodes.value.slice(0, 4).map(nodeNameById).join(" → ");
  return selectedNodes.value.length > 4 ? `${head} → ...` : head;
});
const nodeNameById = (id: number) =>
  nodesList.value.find((node) => node.ID === id)?.Name || String(id);
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
  enabled: computed(() => !isMobile.value),
  startIndex: () => (currentPage.value - 1) * pageSize.value,
  storageKey: "sublink:node-subscriptions:order",
  rowKey: (row) => row.ID,
});

async function loadSubs() {
  const { data } = await getNodeSubscriptions();
  tableData.value = data || [];
}

async function loadNodes() {
  const { data } = await getNodes({ all: "1" });
  nodesList.value = data || [];
}

onMounted(() => {
  loadSubs();
  loadNodes();
});

function resetForm() {
  subName.value = "";
  oldSubName.value = "";
  expireAt.value = "";
  accessLimit.value = undefined;
  selectedNodes.value = [];
  nodeKeyword.value = "";
}

function handleAdd() {
  mode.value = "add";
  resetForm();
  dialogVisible.value = true;
}

function handleEdit(row: any) {
  mode.value = "edit";
  subName.value = row.Name;
  oldSubName.value = row.Name;
  expireAt.value = row.ExpireAt
    ? new Date(row.ExpireAt).toISOString().slice(0, 19).replace("T", " ")
    : "";
  accessLimit.value = row.AccessLimit || undefined;
  selectedNodes.value = (row.Nodes || []).map((item: Node) => item.ID);
  nodeKeyword.value = "";
  dialogVisible.value = true;
}

function validateForm() {
  if (!subName.value.trim()) {
    ElMessage.warning("请输入节点订阅名称");
    return false;
  }
  if (!selectedNodes.value.length) {
    ElMessage.warning("至少选择一个节点");
    return false;
  }
  return true;
}

async function saveSub() {
  if (!validateForm()) return;
  const payload = {
    name: subName.value.trim(),
    nodes: selectedNodes.value.join(","),
    expire_at: expireAt.value || "",
    access_limit: accessLimit.value || "",
  };
  if (mode.value === "add") {
    await addNodeSubscription(payload);
    ElMessage.success("添加成功");
  } else {
    await updateNodeSubscription({
      ...payload,
      oldname: oldSubName.value,
    });
    ElMessage.success("更新成功");
  }
  await loadSubs();
  dialogVisible.value = false;
  const saved = tableData.value.find((item) => item.Name === payload.name);
  if (saved) showClient(saved);
}

function addNode(id: number) {
  if (!selectedNodes.value.includes(id)) selectedNodes.value.push(id);
}

function removeNode(id: number) {
  selectedNodes.value = selectedNodes.value.filter((item) => item !== id);
}

function addAllVisibleNodes() {
  availableNodes.value.forEach((node) => addNode(node.ID));
}

function clearSelectedNodes() {
  selectedNodes.value = [];
}

function handleSelectionChange(val: NodeSub[]) {
  multipleSelection.value = val;
}

function selectAll() {
  if (isMobile.value) {
    multipleSelection.value = [...currentTableData.value];
    return;
  }
  tableData.value.forEach((row) => table.value.toggleRowSelection(row, true));
}

function toggleSelection() {
  if (isMobile.value) {
    multipleSelection.value = [];
    return;
  }
  table.value.clearSelection();
}

async function handleDelete(row: any) {
  await ElMessageBox.confirm(`你是否要删除 ${row.Name} ?`, "提示", {
    confirmButtonText: "确定",
    cancelButtonText: "取消",
    type: "warning",
  });
  await deleteNodeSubscription({ id: row.ID });
  await loadSubs();
  ElMessage.success("删除成功");
}

async function selectDel() {
  if (multipleSelection.value.length === 0) return;
  await ElMessageBox.confirm("你是否要删除选中的节点订阅？", "提示", {
    confirmButtonText: "确定",
    cancelButtonText: "取消",
    type: "warning",
  });
  await Promise.all(
    multipleSelection.value.map((item) =>
      deleteNodeSubscription({ id: item.ID })
    )
  );
  await loadSubs();
  ElMessage.success("删除成功");
}

async function handleResetToken(row: any) {
  await ElMessageBox.confirm(
    `重置 ${row.Name} 的订阅 token？旧 token 会立刻失效。`,
    "重置 token",
    { confirmButtonText: "重置", cancelButtonText: "取消", type: "warning" }
  );
  await resetNodeSubscriptionToken({ id: row.ID });
  await loadSubs();
  ElMessage.success("token 已重置");
}

async function handleToggleRevoked(row: any) {
  await setNodeSubscriptionRevoked({ id: row.ID, revoked: !row.Revoked });
  await loadSubs();
  ElMessage.success(row.Revoked ? "节点订阅已恢复" : "节点订阅已手动失效");
}

function copyUrl(url: string) {
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
  } finally {
    document.body.removeChild(textarea);
  }
}

function showClient(row: any) {
  const serverAddress =
    location.protocol +
    "//" +
    location.hostname +
    (location.port ? ":" + location.port : "");
  clientSubName.value = row.Name;
  clientUrl.value = `${serverAddress}/n/?token=${row.Token}`;
  clientDialog.value = true;
}

function showQrcode(url: string, title: string) {
  qrcode.value = url;
  qrTitle.value = title;
  qrDialog.value = true;
}

function openUrl(url: string) {
  window.open(url);
}

function formatCreatedAt(row: any) {
  return formatBeijingTime(row.CreatedAt);
}

function nodeNames(row: any) {
  return (row.Nodes || []).map((item: Node) => item.Name).join("、") || "--";
}

function isExpired(row: any) {
  return row.ExpireAt && beijingTimestamp(row.ExpireAt) < Date.now();
}

const subStatusText = (row: NodeSub) => {
  if (row.Revoked) return "已失效";
  if (isExpired(row)) return "已过期";
  return "正常";
};

const subStatusClass = (row: NodeSub) => ({
  "is-danger": row.Revoked,
  "is-warning": !row.Revoked && isExpired(row),
});

const compactNodeNames = (row: NodeSub) => {
  const nodes = row.Nodes || [];
  if (!nodes.length) return "未选择节点";
  const head = nodes.slice(0, 3).map((item) => item.Name).join(" / ");
  return nodes.length > 3 ? `${head} 等 ${nodes.length} 个` : head;
};

const isSubSelected = (row: NodeSub) => selectedSubIds.value.has(row.ID);

const toggleMobileSubSelection = (row: NodeSub, checked: boolean) => {
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
</script>

<template>
  <div class="page-workspace mobile-page">
    <el-dialog
      v-model="qrDialog"
      class="form-dialog qr-dialog"
      width="400px"
      :title="qrTitle"
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
          <el-button type="primary" @click="openUrl(qrcode)"
            >打开链接</el-button
          >
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="clientDialog"
      class="form-dialog client-dialog"
      width="760px"
      title="节点订阅链接"
    >
      <div class="client-dialog-head">
        <div>
          <p class="dialog-intro">
            该地址只下发节点原始订阅，不套用 Clash / Surge 模板。
          </p>
          <strong>{{ clientSubName }}</strong>
        </div>
        <el-button type="primary" plain @click="copyUrl(clientUrl)"
          >复制订阅链接</el-button
        >
      </div>
      <article class="client-card">
        <div class="client-card-title">
          <span>节点订阅</span>
          <el-tag size="small" effect="plain">Base64</el-tag>
        </div>
        <p>客户端更新该订阅即可拿到当前选择和排序后的节点列表。</p>
        <el-input :model-value="clientUrl" readonly class="client-url-input" />
        <div class="client-actions">
          <el-button @click="copyUrl(clientUrl)">复制链接</el-button>
          <el-button @click="showQrcode(clientUrl, '节点订阅')"
            >二维码</el-button
          >
          <el-button link type="primary" @click="openUrl(clientUrl)"
            >打开</el-button
          >
        </div>
      </article>
    </el-dialog>

    <el-dialog
      v-model="dialogVisible"
      class="form-dialog node-subscription-dialog"
      width="min(960px, calc(100vw - 32px))"
      :close-on-click-modal="true"
      destroy-on-close
    >
      <template #header>
        <div class="dialog-heading">
          <h2>{{ dialogTitle }}</h2>
          <p>配置节点订阅名称、有效期、访问限制和下发节点顺序。</p>
        </div>
      </template>

      <div class="form-grid">
        <label class="field">
          <span class="field-label">节点订阅名称</span>
          <el-input v-model="subName" placeholder="例如：家人节点 / 手机节点" />
        </label>
        <label class="field">
          <span class="field-label">过期时间</span>
          <el-date-picker
            v-model="expireAt"
            type="datetime"
            value-format="YYYY-MM-DD HH:mm:ss"
            placeholder="不填则长期有效"
            class="field-control"
          />
        </label>
        <label class="field">
          <span class="field-label">访问次数限制</span>
          <el-input-number
            v-model="accessLimit"
            :min="0"
            placeholder="0 表示不限"
            class="field-control"
          />
        </label>
      </div>

      <section class="node-picker">
        <div class="node-panel">
          <div class="node-panel-head">
            <strong>可选节点</strong>
            <el-button link type="primary" @click="addAllVisibleNodes"
              >添加当前列表</el-button
            >
          </div>
          <el-input v-model="nodeKeyword" placeholder="搜索节点" clearable />
          <div class="node-list">
            <button
              v-for="node in availableNodes"
              :key="node.ID || node.Name"
              class="node-option"
              @click="addNode(node.ID)"
            >
              <span>{{ node.Name }}</span>
              <small>添加</small>
            </button>
            <div v-if="availableNodes.length === 0" class="empty-hint">
              没有可添加的节点
            </div>
          </div>
        </div>

        <div class="node-panel">
          <div class="node-panel-head">
            <strong>已选节点</strong>
            <el-button link type="danger" @click="clearSelectedNodes"
              >清空</el-button
            >
          </div>
          <p class="selected-preview">{{ selectedPreview }}</p>
          <vue-draggable
            v-model="selectedNodes"
            target=".selected-node-list"
            :animation="160"
          >
            <div class="selected-node-list">
              <div
                v-for="(nodeId, index) in selectedNodes"
                :key="nodeId"
                class="draggable-item"
              >
                <span class="drag-handle">⋮⋮</span>
                <span class="node-index">{{ index + 1 }}</span>
                <span class="node-name">{{ nodeNameById(nodeId) }}</span>
                <el-button link type="danger" @click.stop="removeNode(nodeId)"
                  >移除</el-button
                >
              </div>
              <div v-if="selectedNodes.length === 0" class="empty-hint">
                从左侧添加节点后，可拖拽调整顺序
              </div>
            </div>
          </vue-draggable>
        </div>
      </section>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" @click="saveSub">
            {{ mode === "add" ? "添加节点订阅" : "保存修改" }}
          </el-button>
        </div>
      </template>
    </el-dialog>

    <div class="page-heading">
      <div>
        <h1>节点订阅分类</h1>
        <p>下发节点原始订阅，不需要模板，适合按用户或设备分类节点。</p>
      </div>
      <el-button type="primary" @click="handleAdd">添加节点订阅</el-button>
    </div>

    <section class="work-surface mobile-app-surface">
      <el-table
        class="desktop-data-table"
        ref="table"
        :data="currentTableData"
        row-key="ID"
        style="width: 100%"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" fixed width="48" />
        <el-table-column width="42" label="">
          <template #default>
            <span class="row-drag-handle" title="拖动排序">☰</span>
          </template>
        </el-table-column>
        <el-table-column
          prop="Name"
          label="节点订阅名称 / 节点"
          min-width="220"
        >
          <template #default="{ row }">
            <span class="primary-cell">{{ row.Name }}</span>
            <p class="node-summary">{{ nodeNames(row) }}</p>
          </template>
        </el-table-column>
        <el-table-column label="订阅链接" min-width="150">
          <template #default="{ row }">
            <el-button link type="primary" @click="showClient(row)"
              >查看链接</el-button
            >
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.Revoked" type="danger" effect="plain"
              >已失效</el-tag
            >
            <el-tag v-else-if="isExpired(row)" type="warning" effect="plain"
              >已过期</el-tag
            >
            <el-tag v-else type="success" effect="plain">有效</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="访问" width="110">
          <template #default="{ row }"
            >{{ row.AccessCount || 0 }}/{{
              row.AccessLimit || "不限"
            }}</template
          >
        </el-table-column>
        <el-table-column
          prop="CreatedAt"
          label="创建时间"
          min-width="180"
          sortable
          :formatter="formatCreatedAt"
        />
        <el-table-column label="操作" width="260" align="right">
          <template #default="{ row }">
            <el-button link @click="handleResetToken(row)"
              >重置 token</el-button
            >
            <el-button link @click="handleToggleRevoked(row)">
              {{ row.Revoked ? "恢复" : "失效" }}
            </el-button>
            <el-button link type="primary" @click="handleEdit(row)"
              >编辑</el-button
            >
            <el-button link type="danger" @click="handleDelete(row)"
              >删除</el-button
            >
          </template>
        </el-table-column>
      </el-table>

      <div class="mobile-only-list mobile-card-list">
        <div v-if="currentTableData.length === 0" class="mobile-empty-state">
          暂无节点订阅
        </div>
        <article
          v-for="row in currentTableData"
          :key="row.ID"
          class="mobile-card"
          :class="{ 'is-muted': row.Revoked || isExpired(row) }"
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
              <strong>{{ compactNodeNames(row) }}</strong>
            </div>
            <div class="mobile-field">
              <span>访问</span>
              <strong>{{ row.AccessCount || 0 }}/{{ row.AccessLimit || "不限" }}</strong>
            </div>
          </div>

          <div class="mobile-card-actions">
            <el-button type="primary" @click="showClient(row)">链接</el-button>
            <el-button type="warning" @click="handleResetToken(row)">
              重置
            </el-button>
            <el-button @click="handleToggleRevoked(row)">
              {{ row.Revoked ? "恢复" : "失效" }}
            </el-button>
            <el-button type="primary" @click="handleEdit(row)">编辑</el-button>
            <el-button type="danger" @click="handleDelete(row)">删除</el-button>
          </div>
        </article>
      </div>

      <div class="table-footer">
        <div class="batch-actions">
          <el-button @click="selectAll">全选</el-button>
          <el-button @click="toggleSelection">取消选择</el-button>
          <el-button type="danger" plain @click="selectDel">删除选中</el-button>
        </div>
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          :total="tableData.length"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.field-control {
  width: 100%;
}

.form-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.node-picker {
  display: grid;
  gap: 16px;
  grid-template-columns: 1fr 1fr;
  margin-top: 18px;
}

.node-panel {
  display: grid;
  gap: 12px;
  min-height: 360px;
  padding: 14px;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.node-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.node-list,
.selected-node-list {
  display: grid;
  align-content: flex-start;
  gap: 8px;
  max-height: 300px;
  overflow: auto;
}

.node-option,
.draggable-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 38px;
  padding: 8px 10px;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}

.node-option {
  width: 100%;
  text-align: left;
  cursor: pointer;
}

.node-option small {
  color: var(--el-color-primary);
}

.drag-handle {
  color: var(--el-text-color-placeholder);
  cursor: grab;
}

.node-index {
  width: 24px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.node-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-hint,
.selected-preview,
.node-summary,
.dialog-intro {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.primary-cell {
  font-weight: 600;
}

.node-summary {
  max-width: 480px;
  margin: 4px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qr-content,
.client-dialog-head,
.client-card,
.client-actions {
  display: grid;
  gap: 12px;
}

.qr-frame {
  display: flex;
  justify-content: center;
  padding: 16px;
  background: #fff;
  border-radius: 10px;
}

.client-dialog-head {
  grid-template-columns: 1fr auto;
  align-items: center;
  margin-bottom: 14px;
}

.client-card {
  padding: 14px;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.client-card-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-weight: 650;
}

.client-actions {
  display: flex;
  flex-wrap: wrap;
}

@media (max-width: 768px) {
  .form-grid,
  .node-picker {
    grid-template-columns: 1fr;
  }

  .client-dialog-head {
    grid-template-columns: 1fr;
  }
}
</style>
