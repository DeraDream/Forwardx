<script setup lang="ts">
import {
  getTelegramConfig,
  TelegramConfig,
  testTelegramBot,
  updateTelegramConfig,
} from "@/api/telegram";
import {
  checkSystemUpdate,
  getSystemUpdateStatus,
  startSystemUpdate,
  SystemUpdateInfo,
  SystemUpdateStatus,
} from "@/api/system/update";
import { exportBackup, importBackup } from "@/api/backup";

defineOptions({
  name: "TelegramBot",
});

const loading = ref(false);
const saving = ref(false);
const testing = ref(false);
const languageSelectRef = ref<{ blur: () => void }>();
const updateChecking = ref(false);
const updateStarting = ref(false);
const updateCheckFailed = ref(false);
const updateInfo = ref<SystemUpdateInfo>();
const updateStatus = ref<SystemUpdateStatus>();
let updatePollTimer: ReturnType<typeof setTimeout> | undefined;
let updateReloadTimer: ReturnType<typeof setTimeout> | undefined;
let updatePollStartedAt = 0;
const backupImportInput = ref<HTMLInputElement>();
const backupExporting = ref(false);
const backupImporting = ref(false);
const backupExportPassword = ref("");

async function downloadBackup() {
  const password = backupExportPassword.value;
  if (password && password.length < 8) {
    ElMessage.warning("加密密码至少 8 位");
    return;
  }
  backupExporting.value = true;
  try {
    const formData = new FormData();
    if (password) formData.append("password", password);
    const response: any = await exportBackup(formData);
    const url = URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement("a");
    link.href = url;
    link.download = `sublink-backup-${new Date().toISOString().slice(0, 10)}.sublink-backup`;
    link.click();
    URL.revokeObjectURL(url);
    ElMessage.success("备份已导出");
  } finally {
    backupExporting.value = false;
  }
}

function selectBackup() {
  backupImportInput.value?.click();
}

function redirectAfterRestore(port: number, delay: number) {
  const target = new URL(window.location.href);
  target.protocol = "http:";
  target.port = String(port);
  target.pathname = "/";
  target.hash = "";
  window.setTimeout(() => window.location.replace(target.toString()), delay);
}

async function restoreBackup(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const encrypted =
    new TextDecoder().decode(await file.slice(0, 8).arrayBuffer()) ===
    "SLXBACK1";
  let password = "";
  try {
    if (encrypted) {
      const result = await ElMessageBox.prompt(
        "此备份已加密，请输入备份密码。",
        "输入备份密码",
        {
          inputType: "password",
          inputPlaceholder: "至少 8 位",
          inputValidator: (value) => value.length >= 8 || "备份密码至少 8 位",
          confirmButtonText: "继续",
          cancelButtonText: "取消",
        }
      );
      password = result.value;
    }
    await ElMessageBox.confirm(
      `导入会覆盖当前全部数据、配置和模板，且恢复管理员账号密码。${encrypted ? "备份已加密。" : "备份未加密。"}确认继续？`,
      "确认恢复整库备份",
      { type: "warning", confirmButtonText: "确认恢复", cancelButtonText: "取消" }
    );
  } catch {
    input.value = "";
    return;
  }
  backupImporting.value = true;
  try {
    const formData = new FormData();
    formData.append("file", file);
    if (password) formData.append("password", password);
    const { data } = await importBackup(formData);
    ElMessage.success("恢复成功，服务正在重启并跳转到备份端口");
    redirectAfterRestore(data.port, data.restart_delay_ms || 4500);
  } finally {
    backupImporting.value = false;
    input.value = "";
  }
}

const updateInProgress = computed(() =>
  ["queued", "downloading", "installing", "restarting"].includes(
    updateStatus.value?.state || ""
  )
);
const updateMessage = computed(
  () => updateStatus.value?.message || "正在准备在线更新"
);

const closeLanguageSelect = () => {
  nextTick(() => languageSelectRef.value?.blur());
};

const form = reactive<TelegramConfig>({
  enabled: false,
  token: "",
  token_configured: false,
  admin_chat_ids: "",
  language: "zh-CN",
  api_base_url: "https://api.telegram.org",
  public_base_url: "https://sublink.yforward7.com",
});

const tokenPlaceholder = computed(() =>
  form.token_configured
    ? "Token 已配置，留空表示不修改"
    : "从 @BotFather 获取机器人 Token"
);

async function loadConfig() {
  loading.value = true;
  try {
    const { data } = await getTelegramConfig();
    Object.assign(form, data, { token: "" });
  } finally {
    loading.value = false;
  }
}

function validate(requireToken = false) {
  if (!form.admin_chat_ids.trim()) {
    ElMessage.warning("请输入管理员聊天 ID");
    return false;
  }
  if (
    (form.enabled || requireToken) &&
    !form.token.trim() &&
    !form.token_configured
  ) {
    ElMessage.warning("请输入 Telegram Token");
    return false;
  }
  if (!/^https?:\/\//i.test(form.api_base_url.trim())) {
    ElMessage.warning("Telegram API 地址格式不正确");
    return false;
  }
  if (!/^https?:\/\//i.test(form.public_base_url.trim())) {
    ElMessage.warning("主控公网地址格式不正确");
    return false;
  }
  return true;
}

async function saveConfig() {
  if (form.enabled && !validate()) {
    return;
  }
  saving.value = true;
  try {
    await updateTelegramConfig(form);
    const tokenWasEntered = Boolean(form.token.trim());
    form.token = "";
    form.token_configured = form.token_configured || tokenWasEntered;
    ElMessage.success("Telegram 机器人配置已保存");
    await loadConfig();
  } finally {
    saving.value = false;
  }
}

async function sendTestMessage() {
  if (!validate(true)) {
    return;
  }
  testing.value = true;
  try {
    await testTelegramBot(form);
    ElMessage.success("测试消息已发送");
  } finally {
    testing.value = false;
  }
}

function stopUpdatePolling() {
  if (updatePollTimer) clearTimeout(updatePollTimer);
  updatePollTimer = undefined;
}

function scheduleUpdatePoll(delay = 1500) {
  stopUpdatePolling();
  updatePollTimer = setTimeout(pollUpdateStatus, delay);
}

async function pollUpdateStatus() {
  if (
    updatePollStartedAt &&
    Date.now() - updatePollStartedAt > 15 * 60 * 1000
  ) {
    stopUpdatePolling();
    updateStatus.value = {
      ...(updateStatus.value as SystemUpdateStatus),
      state: "failed",
      message: "更新超时，请检查服务状态和后台日志",
    };
    ElMessage.error(updateStatus.value.message);
    return;
  }
  try {
    const { data } = await getSystemUpdateStatus();
    updateStatus.value = data;
    if (data.state === "completed") {
      stopUpdatePolling();
      ElMessage.success("在线更新完成，正在刷新页面");
      updateReloadTimer = setTimeout(() => window.location.reload(), 1200);
      return;
    }
    if (data.state === "failed") {
      stopUpdatePolling();
      ElMessage.error(data.message || "在线更新失败");
      return;
    }
  } catch {
    // 服务重启期间连接会短暂中断，继续轮询即可恢复进度。
  }
  scheduleUpdatePoll(updateStatus.value?.state === "restarting" ? 2000 : 1500);
}

async function loadUpdateInfo(showResult = false) {
  updateChecking.value = true;
  updateCheckFailed.value = false;
  try {
    const { data } = await checkSystemUpdate();
    updateInfo.value = data;
    updateStatus.value = data.status;
    if (updateInProgress.value) {
      updatePollStartedAt = Date.now();
      scheduleUpdatePoll(500);
    } else if (showResult) {
      ElMessage.success(
        data.update_available
          ? `发现新版本 ${data.latest_version}`
          : "当前已是最新版本"
      );
    }
  } catch {
    updateCheckFailed.value = true;
    if (showResult) ElMessage.error("检查更新失败，请稍后重试");
  } finally {
    updateChecking.value = false;
  }
}

async function beginSystemUpdate() {
  if (!updateInfo.value?.update_available) return;
  try {
    await ElMessageBox.confirm(
      `将从 ${updateInfo.value.current_version} 更新到 ${updateInfo.value.latest_version}，期间服务会短暂重启。`,
      "确认在线更新",
      {
        type: "warning",
        confirmButtonText: "开始更新",
        cancelButtonText: "取消",
      }
    );
  } catch {
    return;
  }
  updateStarting.value = true;
  try {
    const { data } = await startSystemUpdate();
    updateStatus.value = data;
    updatePollStartedAt = Date.now();
    scheduleUpdatePoll(500);
  } catch {
    await loadUpdateInfo(false);
  } finally {
    updateStarting.value = false;
  }
}

onMounted(() => {
  loadConfig();
  loadUpdateInfo(false);
});

onBeforeUnmount(() => {
  stopUpdatePolling();
  if (updateReloadTimer) clearTimeout(updateReloadTimer);
});
</script>

<template>
  <div v-loading="loading" class="page-workspace telegram-page">
    <div class="page-heading">
      <div>
        <h1>系统设置</h1>
        <p>管理 SublinkX 在线更新与 Telegram 机器人</p>
      </div>
      <span class="bot-status" :class="{ active: form.enabled }">
        <i />
        {{ form.enabled ? "已启用" : "未启用" }}
      </span>
    </div>

    <section class="work-surface system-update-settings">
      <div class="section-heading">
        <svg-icon icon-class="refresh" size="17px" />
        <span>系统更新</span>
      </div>

      <div class="setting-row update-row">
        <div class="setting-copy">
          <strong>在线升级</strong>
          <span v-if="updateInfo">
            当前版本 {{ updateInfo.current_version }}，最新版本
            {{ updateInfo.latest_version }}
          </span>
          <span v-else-if="updateCheckFailed">
            版本信息获取失败，可点击按钮重新检查
          </span>
          <span v-else>正在获取版本信息</span>
        </div>
        <div class="update-control">
          <el-tag
            v-if="updateInfo?.update_available"
            type="warning"
            effect="plain"
          >
            发现 {{ updateInfo.latest_version }}
          </el-tag>
          <el-tag v-else-if="updateInfo" type="success" effect="plain">
            已是最新版本
          </el-tag>
          <el-button :loading="updateChecking" @click="loadUpdateInfo(true)">
            检查更新
          </el-button>
          <el-button
            v-if="updateInfo?.update_available"
            type="primary"
            :loading="updateStarting"
            :disabled="!updateInfo.supported"
            @click="beginSystemUpdate"
          >
            在线更新
          </el-button>
        </div>
      </div>
      <div
        v-if="updateInfo && !updateInfo.supported"
        class="update-unsupported"
      >
        {{ updateInfo.unsupported_reason }}
      </div>
    </section>

    <section class="work-surface telegram-settings">
      <div class="section-heading">
        <svg-icon icon-class="setting" size="17px" />
        <span>常规设置</span>
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>启用 Telegram 机器人</strong>
          <span>启用后由 SublinkX 后台持续接收机器人消息</span>
        </div>
        <el-switch v-model="form.enabled" />
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>Telegram Token</strong>
          <span>从 @BotFather 获取的机器人令牌，保存后不会明文显示</span>
        </div>
        <el-input
          v-model="form.token"
          class="setting-control"
          type="password"
          show-password
          :placeholder="tokenPlaceholder"
          autocomplete="new-password"
        />
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>管理员聊天 ID</strong>
          <span>只有这些 Chat ID 可以查看和修改数据，多个 ID 使用逗号分隔</span>
        </div>
        <el-input
          v-model="form.admin_chat_ids"
          class="setting-control"
          placeholder="例如：123456789, 987654321"
        />
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>机器人语言</strong>
          <span>机器人菜单和回复消息使用的语言</span>
        </div>
        <el-select
          ref="languageSelectRef"
          v-model="form.language"
          class="setting-control"
          @change="closeLanguageSelect"
        >
          <el-option label="简体中文" value="zh-CN" />
        </el-select>
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>Telegram API 服务器</strong>
          <span>留空使用 Telegram 官方 API，也可以填写自建反向代理地址</span>
        </div>
        <el-input
          v-model="form.api_base_url"
          class="setting-control"
          placeholder="https://api.telegram.org"
        />
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>主控公网地址</strong>
          <span
            >Telegram 生成订阅链接时使用，例如
            https://sublink.yforward7.com</span
          >
        </div>
        <el-input
          v-model="form.public_base_url"
          class="setting-control"
          placeholder="https://sublink.yforward7.com"
        />
      </div>

      <div class="settings-actions">
        <el-button :loading="testing" @click="sendTestMessage">
          发送测试消息
        </el-button>
        <el-button type="primary" :loading="saving" @click="saveConfig">
          保存配置
        </el-button>
      </div>
    </section>

    <section class="work-surface backup-settings">
      <div class="section-heading">
        <svg-icon icon-class="lock" size="17px" />
        <span>整库备份</span>
      </div>
      <div class="setting-row">
        <div class="setting-copy">
          <strong>导出或恢复全部数据</strong>
          <span>包含节点、订阅、模板、配置和管理员账号密码；导出时可选加密</span>
        </div>
        <div class="backup-control">
          <el-input
            v-model="backupExportPassword"
            type="password"
            show-password
            placeholder="加密密码（可选，至少 8 位）"
            autocomplete="new-password"
          />
          <input
            ref="backupImportInput"
            type="file"
            accept=".sublink-backup"
            hidden
            @change="restoreBackup"
          />
          <el-button :loading="backupExporting" @click="downloadBackup">
            导出备份
          </el-button>
          <el-button
            type="warning"
            :loading="backupImporting"
            @click="selectBackup"
          >
            导入恢复
          </el-button>
        </div>
      </div>
    </section>

    <section class="work-surface bot-capabilities">
      <div class="section-heading">
        <svg-icon icon-class="message" size="17px" />
        <span>机器人功能</span>
      </div>
      <div class="capability-grid">
        <div class="capability">
          <svg-icon icon-class="publish" size="19px" />
          <div>
            <strong>节点列表</strong>
            <span>查看节点名称、协议和所属分组</span>
          </div>
        </div>
        <div class="capability">
          <svg-icon icon-class="link" size="19px" />
          <div>
            <strong>订阅列表</strong>
            <span>查看订阅名称及包含的节点数量</span>
          </div>
        </div>
        <div class="capability">
          <svg-icon icon-class="edit" size="19px" />
          <div>
            <strong>添加节点</strong>
            <span>发送节点链接，可同时指定一个或多个分组</span>
          </div>
        </div>
        <div class="capability danger">
          <svg-icon icon-class="close" size="19px" />
          <div>
            <strong>删除节点</strong>
            <span>从机器人菜单选择节点，并进行二次确认</span>
          </div>
        </div>
      </div>
    </section>

    <div v-if="updateInProgress" class="update-loading-overlay">
      <div class="update-loading-dialog" role="status" aria-live="polite">
        <span class="update-spinner" />
        <strong>{{ updateMessage }}</strong>
        <span>
          {{ updateStatus?.current_version }} →
          {{ updateStatus?.target_version }}
        </span>
        <el-progress
          :percentage="Math.max(1, updateStatus?.progress || 1)"
          :stroke-width="8"
          :show-text="true"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.telegram-page {
  max-width: 1440px;
  margin: 0 auto;
}

.bot-status {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.bot-status i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);
}

.bot-status.active {
  color: #15803d;
}

.bot-status.active i {
  background: #16a34a;
}

.telegram-settings,
.bot-capabilities,
.system-update-settings,
.backup-settings {
  padding: 0 24px;
}

.telegram-settings,
.bot-capabilities,
.backup-settings {
  margin-top: 18px;
  padding-bottom: 24px;
}

.backup-control {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.backup-control .el-input {
  min-width: 220px;
}

.section-heading {
  display: flex;
  gap: 9px;
  align-items: center;
  min-height: 58px;
  color: var(--el-color-primary);
  font-size: 14px;
  font-weight: 650;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.setting-row {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) minmax(360px, 48%);
  gap: 32px;
  align-items: center;
  min-height: 82px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.setting-copy strong,
.setting-copy span,
.capability strong,
.capability span {
  display: block;
}

.setting-copy strong,
.capability strong {
  margin-bottom: 6px;
  color: var(--el-text-color-primary);
  font-size: 14px;
}

.setting-copy span,
.capability span {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.55;
}

.setting-control {
  width: 100%;
}

.update-control {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: flex-end;
}

.update-control .el-button + .el-button {
  margin-left: 0;
}

.update-unsupported {
  padding: 12px 20px 16px;
  color: var(--el-color-warning);
  font-size: 13px;
}

.update-loading-overlay {
  position: fixed;
  z-index: 3000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgb(15 23 42 / 52%);
  backdrop-filter: blur(2px);
}

.update-loading-dialog {
  display: grid;
  width: min(420px, 100%);
  gap: 14px;
  padding: 26px;
  color: var(--el-text-color-primary);
  text-align: center;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  box-shadow: var(--el-box-shadow-dark);
}

.update-loading-dialog > span:not(.update-spinner) {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.update-spinner {
  width: 34px;
  height: 34px;
  margin: 0 auto;
  border: 3px solid var(--el-color-primary-light-8);
  border-top-color: var(--el-color-primary);
  border-radius: 50%;
  animation: update-spin 0.8s linear infinite;
}

@keyframes update-spin {
  to {
    transform: rotate(360deg);
  }
}

.settings-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  padding: 18px 20px;
}

.settings-actions .el-button + .el-button {
  margin-left: 0;
}

.capability-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  padding-top: 20px;
}

.capability {
  display: flex;
  gap: 13px;
  min-width: 0;
  padding: 16px 20px;
  color: var(--el-color-primary);
  border-right: 1px solid var(--el-border-color-lighter);
}

.capability:last-child {
  border-right: 0;
}

.capability.danger {
  color: var(--el-color-danger);
}

html.dark .bot-status.active {
  color: #86efac;
}

@media (max-width: 960px) {
  .setting-row {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .capability-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .capability:nth-child(2) {
    border-right: 0;
  }
}

@media (max-width: 640px) {
  .telegram-settings,
  .bot-capabilities,
  .system-update-settings,
  .backup-settings {
    padding-right: 14px;
    padding-left: 14px;
  }

  .backup-control .el-input {
    width: 100%;
    min-width: 0;
  }

  .setting-row {
    padding-right: 0;
    padding-left: 0;
  }

  .capability-grid {
    grid-template-columns: 1fr;
  }

  .capability {
    border-right: 0;
    border-bottom: 1px solid var(--el-border-color-lighter);
  }

  .capability:last-child {
    border-bottom: 0;
  }
}
</style>
