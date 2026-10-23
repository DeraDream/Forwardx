<template>
  <div class="logo-container">
    <transition enter-active-class="animate__animated animate__fadeInLeft">
      <router-link v-if="collapse" class="wh-full flex-center" to="/">
        <img v-if="settingsStore.sidebarLogo" :src="logo" class="logo-image" />
        <button v-if="updateInfo?.update_available" class="update-badge collapsed" title="发现新版本" @click.prevent.stop="confirmUpdate">↑</button>
      </router-link>

      <router-link v-else class="wh-full flex-center" to="/">
        <img v-if="settingsStore.sidebarLogo" :src="logo" class="logo-image" />
        <span class="logo-title"> {{ defaultSettings.title }}</span>
        <button v-if="updateInfo?.update_available" class="update-badge" @click.prevent.stop="confirmUpdate">↑ 新版本</button>
      </router-link>
    </transition>
    <el-dialog v-model="updateProgressVisible" class="sidebar-update-dialog" width="min(430px, calc(100vw - 36px))" :close-on-click-modal="false" :close-on-press-escape="false" :show-close="false" align-center>
      <div class="update-progress" role="status" aria-live="polite">
        <span class="update-spinner" />
        <h3>正在升级 SublinkX</h3>
        <p>{{ updateStatus?.message || "正在准备更新，请勿关闭页面" }}</p>
        <div class="version-line">{{ updateStatus?.current_version || updateInfo?.current_version }} <span>→</span> {{ updateStatus?.target_version || updateInfo?.latest_version }}</div>
        <el-progress :percentage="Math.max(1, updateStatus?.progress || 1)" :stroke-width="9" />
        <small>升级期间服务会短暂重启，页面将自动恢复。</small>
        <el-button v-if="updateFailed" @click="updateProgressVisible = false">关闭</el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script lang="ts" setup>
import defaultSettings from "@/settings";
import { useSettingsStore } from "@/store";
import { checkSystemUpdate, getSystemUpdateStatus, startSystemUpdate, type SystemUpdateInfo, type SystemUpdateStatus } from "@/api/system/update";

const settingsStore = useSettingsStore();

defineProps({
  collapse: {
    type: Boolean,
    required: true,
  },
});

const logo = ref(new URL(`../../../../assets/logo.png`, import.meta.url).href);
const updateInfo = ref<SystemUpdateInfo>();
const updating = ref(false);
const updateProgressVisible = ref(false);
const updateStatus = ref<SystemUpdateStatus>();
const updateFailed = computed(() => updateStatus.value?.state === "failed");
let updatePollTimer: ReturnType<typeof setTimeout> | undefined;
let updateStartedAt = 0;

async function loadUpdateInfo() {
  try {
    const { data } = await checkSystemUpdate();
    updateInfo.value = data;
  } catch {
    // A version check must never prevent navigation from rendering.
  }
}

async function confirmUpdate() {
  if (!updateInfo.value?.update_available || updating.value) return;
  try {
    await ElMessageBox.confirm(
      `发现新版本 ${updateInfo.value.latest_version}，是否立即升级？服务会短暂重启。`,
      "新版本可用",
      { type: "warning", confirmButtonText: "立即升级", cancelButtonText: "暂不升级" }
    );
  } catch {
    return;
  }
  updating.value = true;
  try {
    const { data } = await startSystemUpdate();
    updateStatus.value = data;
    updateProgressVisible.value = true;
    updateStartedAt = Date.now();
    pollUpdateStatus(500);
  } catch {
    updating.value = false;
  }
}

function stopUpdatePolling() {
  if (updatePollTimer) clearTimeout(updatePollTimer);
  updatePollTimer = undefined;
}

function pollUpdateStatus(delay = 1500) {
  stopUpdatePolling();
  updatePollTimer = setTimeout(async () => {
    if (updateStartedAt && Date.now() - updateStartedAt > 15 * 60 * 1000) {
      updateStatus.value = { ...(updateStatus.value as SystemUpdateStatus), state: "failed", message: "升级超时，请检查服务状态和后台日志" };
      updating.value = false;
      return;
    }
    try {
      const { data } = await getSystemUpdateStatus();
      updateStatus.value = data;
      if (data.state === "completed") {
        window.setTimeout(() => window.location.reload(), 900);
        return;
      }
      if (data.state === "failed") {
        updating.value = false;
        return;
      }
    } catch {
      // 服务重启时请求暂时失败是正常现象，继续轮询即可。
    }
    pollUpdateStatus(updateStatus.value?.state === "restarting" ? 2000 : 1200);
  }, delay);
}

onMounted(loadUpdateInfo);
onBeforeUnmount(stopUpdatePolling);
</script>

<style lang="scss" scoped>
.logo-container {
	position: relative;
  width: 100%;
  height: $navbar-height;
  background-color: $sidebar-logo-background;
  border-bottom: 1px solid var(--el-border-color-lighter);

  .logo-image {
    width: 28px;
    height: 28px;
  }

  .logo-title {
    flex-shrink: 0;
    margin-left: 10px;
    font-size: 14px;
    font-weight: 650;
    color: var(--el-text-color-primary);
  }

  .update-badge {
    margin-left: auto;
    margin-right: 10px;
    padding: 3px 7px;
    border: 0;
    border-radius: 10px;
    color: #fff;
    background: var(--el-color-danger);
    font-size: 11px;
    font-weight: 650;
    cursor: pointer;

    &.collapsed { position: absolute; top: 4px; right: 2px; margin: 0; padding: 1px 5px; }
  }
}

/* This dialog must size to its progress content.  Keep it isolated from the
   full-height editor dialog used by Template Management. */
:deep(.sidebar-update-dialog) {
  display: block !important;
  box-sizing: border-box;
  width: min(430px, calc(100vw - 36px));
  height: auto !important;
  min-height: 0 !important;
  max-height: calc(100dvh - 48px);
  margin: auto !important;
}
:deep(.sidebar-update-dialog .el-dialog__body) {
  max-height: none;
  padding: 30px;
  overflow: visible;
}
.update-progress { display:flex; flex-direction:column; align-items:center; text-align:center; gap:10px; }
.update-progress h3 { margin:2px 0 0; font-size:19px; }
.update-progress p, .update-progress small { margin:0; color:var(--el-text-color-secondary); line-height:1.6; }
.update-progress .el-progress { width:100%; margin:8px 0 2px; }
.version-line { padding:6px 10px; border-radius:6px; color:var(--el-text-color-regular); background:var(--el-fill-color-light); font:13px ui-monospace, SFMono-Regular, Menlo, monospace; }
.version-line span { margin:0 7px; color:var(--el-color-primary); }
.update-spinner { width:36px; height:36px; border:3px solid var(--el-color-primary-light-7); border-top-color:var(--el-color-primary); border-radius:50%; animation:update-spin .8s linear infinite; }
@keyframes update-spin { to { transform:rotate(360deg); } }
</style>
