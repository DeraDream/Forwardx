<template>
  <div class="dashboard-page">
    <section class="hero-panel">
      <div>
        <p class="eyebrow">SUBLINKX</p>
        <h1>{{ greeting }}，{{ displayName }}</h1>
        <p class="hero-copy">
          当前共有 {{ totals.subscriptions }} 个订阅、{{ totals.nodes }} 个节点、
          {{ totals.nodeSubscriptions }} 个节点订阅分类和 {{ totals.templates }} 个模板。
        </p>
      </div>
      <div class="hero-meta">
        <span class="status-dot" />
        <span>服务运行中</span>
        <strong>v{{ version }}</strong>
      </div>
    </section>

    <section class="metric-grid">
      <article v-for="item in metricCards" :key="item.key" class="metric-card">
        <div class="metric-icon" :class="item.key">
          <svg-icon :icon-class="item.icon" size="22px" />
        </div>
        <div>
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
          <small>{{ item.hint }}</small>
        </div>
      </article>
    </section>

    <section class="dashboard-grid">
      <article class="panel">
        <div class="panel-head">
          <div>
            <h2>订阅状态</h2>
            <p>有效期、手动失效和访问限制概览</p>
          </div>
        </div>
        <div class="status-list">
          <div v-for="item in subscriptionStatus" :key="item.label">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </div>
        </div>
      </article>

      <article class="panel">
        <div class="panel-head">
          <div>
            <h2>节点状态</h2>
            <p>节点可用性和分组覆盖情况</p>
          </div>
        </div>
        <div class="status-list">
          <div>
            <span>可用节点</span>
            <strong>{{ nodeHealth.enabled }}</strong>
          </div>
          <div>
            <span>禁用节点</span>
            <strong>{{ nodeHealth.disabled }}</strong>
          </div>
          <div>
            <span>已分组节点</span>
            <strong>{{ nodeHealth.grouped }}</strong>
          </div>
        </div>
      </article>

      <article class="panel quick-panel">
        <div class="panel-head">
          <div>
            <h2>快捷入口</h2>
            <p>常用管理动作</p>
          </div>
        </div>
        <div class="quick-actions">
          <button
            v-for="item in quickActions"
            :key="item.path"
            type="button"
            @click="router.push(item.path)"
          >
            <svg-icon :icon-class="item.icon" />
            <span>{{ item.label }}</span>
          </button>
        </div>
      </article>

      <article class="panel recent-panel">
        <div class="panel-head">
          <div>
            <h2>最近订阅</h2>
            <p>按当前列表顺序展示前几项</p>
          </div>
        </div>
        <div class="recent-list">
          <div v-for="item in recentSubscriptions" :key="item.ID">
            <strong>{{ item.Name }}</strong>
            <span>{{ item.Nodes?.length || 0 }} 个节点</span>
          </div>
          <p v-if="recentSubscriptions.length === 0" class="empty-text">
            暂无订阅
          </p>
        </div>
      </article>
    </section>
  </div>
</template>

<script setup lang="ts">
defineOptions({
  name: "Dashboard",
  inheritAttrs: false,
});

import { useUserStore } from "@/store/modules/user";
import { getSubTotal, getNodeTotal } from "@/api/total";
import { getSubs } from "@/api/subcription/subs";
import { getNodes } from "@/api/subcription/node";
import { getNodeSubscriptions } from "@/api/subcription/node-subscription";
import { getTemp } from "@/api/subcription/temp";
import { GetVersion } from "@/api/auth";
import { beijingTimestamp } from "@/utils/time";

interface NodeItem {
  ID: number;
  Name: string;
  Disabled?: boolean;
  GroupNodes?: unknown[];
}

interface SubscriptionItem {
  ID: number;
  Name: string;
  Nodes?: NodeItem[];
  Revoked?: boolean;
  ExpireAt?: string;
  AccessLimit?: number;
  AccessCount?: number;
}

const router = useRouter();
const userStore = useUserStore();
const version = ref("");
const subscriptions = ref<SubscriptionItem[]>([]);
const nodes = ref<NodeItem[]>([]);
const nodeSubscriptions = ref<SubscriptionItem[]>([]);
const templates = ref<any[]>([]);
const totals = reactive({
  subscriptions: 0,
  nodes: 0,
  nodeSubscriptions: 0,
  templates: 0,
});

const displayName = computed(
  () => userStore.user.nickname || userStore.user.username || "管理员"
);

const greeting = computed(() => {
  const hour = new Date().getHours();
  if (hour < 12) return "上午好";
  if (hour < 18) return "下午好";
  return "晚上好";
});

const expiredCount = computed(
  () =>
    subscriptions.value.filter(
      (item) => item.ExpireAt && beijingTimestamp(item.ExpireAt) < Date.now()
    ).length
);
const revokedCount = computed(
  () => subscriptions.value.filter((item) => item.Revoked).length
);
const activeCount = computed(
  () => Math.max(0, totals.subscriptions - expiredCount.value - revokedCount.value)
);
const limitedCount = computed(
  () => subscriptions.value.filter((item) => Number(item.AccessLimit || 0) > 0).length
);
const nodeHealth = computed(() => ({
  enabled: nodes.value.filter((item) => !item.Disabled).length,
  disabled: nodes.value.filter((item) => item.Disabled).length,
  grouped: nodes.value.filter((item) => (item.GroupNodes?.length || 0) > 0).length,
}));

const metricCards = computed(() => [
  {
    key: "subscriptions",
    label: "订阅",
    value: totals.subscriptions,
    hint: `${activeCount.value} 个有效`,
    icon: "message",
  },
  {
    key: "nodes",
    label: "节点",
    value: totals.nodes,
    hint: `${nodeHealth.value.enabled} 个可用`,
    icon: "link",
  },
  {
    key: "nodeSubs",
    label: "节点订阅分类",
    value: totals.nodeSubscriptions,
    hint: "原始节点订阅",
    icon: "tree",
  },
  {
    key: "templates",
    label: "模板",
    value: totals.templates,
    hint: "Clash / Surge",
    icon: "document",
  },
]);

const subscriptionStatus = computed(() => [
  { label: "有效订阅", value: activeCount.value },
  { label: "已失效", value: revokedCount.value },
  { label: "已过期", value: expiredCount.value },
  { label: "访问限制", value: limitedCount.value },
]);

const quickActions = [
  { label: "订阅列表", path: "/subs/index", icon: "link" },
  { label: "节点列表", path: "/nodes/index", icon: "publish" },
  { label: "节点订阅分类", path: "/node-subs/index", icon: "tree" },
  { label: "模板列表", path: "/templates/index", icon: "document" },
  { label: "系统设置", path: "/settings/telegram", icon: "setting" },
];

const recentSubscriptions = computed(() => subscriptions.value.slice(0, 5));

function normalizeNodeResponse(data: any): NodeItem[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

onMounted(async () => {
  const [
    subTotalResult,
    nodeTotalResult,
    subsResult,
    nodesResult,
    nodeSubsResult,
    templatesResult,
    versionResult,
  ] = await Promise.allSettled([
    getSubTotal(),
    getNodeTotal(),
    getSubs(),
    getNodes({ all: "1" }),
    getNodeSubscriptions(),
    getTemp(),
    GetVersion(),
  ]);

  if (subTotalResult.status === "fulfilled") {
    totals.subscriptions = Number(subTotalResult.value.data || 0);
  }
  if (nodeTotalResult.status === "fulfilled") {
    totals.nodes = Number(nodeTotalResult.value.data || 0);
  }
  if (subsResult.status === "fulfilled") {
    subscriptions.value = subsResult.value.data || [];
    totals.subscriptions = totals.subscriptions || subscriptions.value.length;
  }
  if (nodesResult.status === "fulfilled") {
    nodes.value = normalizeNodeResponse(nodesResult.value.data);
    totals.nodes = totals.nodes || nodes.value.length;
  }
  if (nodeSubsResult.status === "fulfilled") {
    nodeSubscriptions.value = nodeSubsResult.value.data || [];
    totals.nodeSubscriptions = nodeSubscriptions.value.length;
  }
  if (templatesResult.status === "fulfilled") {
    templates.value = templatesResult.value.data || [];
    totals.templates = templates.value.length;
  }
  if (versionResult.status === "fulfilled") {
    version.value = versionResult.value.data || "";
  }
});
</script>

<style lang="scss" scoped>
.dashboard-page {
  min-height: calc(100vh - 50px);
  padding: 28px;
  background:
    radial-gradient(circle at top right, rgb(37 99 235 / 10%), transparent 34%),
    var(--el-bg-color-page);
}

.hero-panel,
.metric-card,
.panel {
  border: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
  box-shadow: 0 12px 32px rgb(15 23 42 / 6%);
}

.hero-panel {
  display: flex;
  gap: 18px;
  align-items: flex-end;
  justify-content: space-between;
  padding: 26px;
  border-radius: 10px;
}

.eyebrow {
  margin: 0 0 8px;
  color: var(--el-color-primary);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.14em;
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  color: var(--el-text-color-primary);
  font-size: 28px;
  font-weight: 750;
}

.hero-copy,
.panel-head p,
.metric-card small,
.recent-list span,
.empty-text {
  color: var(--el-text-color-secondary);
}

.hero-copy {
  max-width: 720px;
  margin-top: 10px;
  font-size: 14px;
  line-height: 1.7;
}

.hero-meta {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  white-space: nowrap;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.hero-meta strong {
  color: var(--el-text-color-primary);
}

.status-dot {
  width: 8px;
  height: 8px;
  background: #16a34a;
  border-radius: 999px;
  box-shadow: 0 0 0 5px rgb(22 163 74 / 12%);
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.metric-card {
  display: flex;
  gap: 14px;
  align-items: center;
  min-height: 112px;
  padding: 18px;
  border-radius: 10px;
}

.metric-icon {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  color: #58a6ff;
  background: rgb(9 105 255 / 12%);
  border-radius: 10px;
  place-items: center;
}

.metric-icon.nodes {
  color: #34d399;
  background: rgb(16 185 129 / 12%);
}

.metric-icon.nodeSubs {
  color: #a78bfa;
  background: rgb(139 92 246 / 14%);
}

.metric-icon.templates {
  color: #f59e0b;
  background: rgb(245 158 11 / 14%);
}

.metric-card span,
.metric-card strong,
.metric-card small {
  display: block;
}

.metric-card span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.metric-card strong {
  color: var(--el-text-color-primary);
  font-size: 28px;
  font-weight: 760;
  line-height: 1.15;
}

.metric-card small {
  margin-top: 4px;
  font-size: 12px;
}

.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.panel {
  padding: 18px;
  border-radius: 10px;
}

.panel-head {
  margin-bottom: 14px;
}

.panel-head h2 {
  color: var(--el-text-color-primary);
  font-size: 16px;
  font-weight: 700;
}

.panel-head p {
  margin-top: 4px;
  font-size: 12px;
}

.status-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.status-list div,
.recent-list div {
  display: grid;
  gap: 4px;
  padding: 12px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.status-list span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.status-list strong,
.recent-list strong {
  color: var(--el-text-color-primary);
  font-size: 18px;
}

.quick-actions,
.recent-list {
  display: grid;
  gap: 9px;
}

.quick-actions {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.quick-actions button {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 42px;
  padding: 0 12px;
  color: var(--el-text-color-primary);
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
}

.quick-actions button:hover {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary-light-5);
}

html.dark .dashboard-page {
  background:
    radial-gradient(circle at top right, rgb(37 99 235 / 18%), transparent 34%),
    #05070b;
}

html.dark .hero-panel,
html.dark .metric-card,
html.dark .panel {
  background: #090c12;
  border-color: #202631;
  box-shadow: 0 18px 40px rgb(0 0 0 / 30%);
}

html.dark .status-list div,
html.dark .recent-list div,
html.dark .quick-actions button {
  background: #151820;
  border-color: #2a303b;
}

@media (max-width: 1100px) {
  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 768px) {
  .dashboard-page {
    padding: 12px 10px calc(92px + env(safe-area-inset-bottom));
  }

  .hero-panel {
    display: grid;
    padding: 16px;
  }

  h1 {
    font-size: 22px;
  }

  .hero-meta {
    justify-self: start;
  }

  .metric-grid,
  .dashboard-grid,
  .quick-actions {
    grid-template-columns: 1fr;
  }

  .status-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
