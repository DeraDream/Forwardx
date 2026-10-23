<template>
  <div class="flex">
    <template v-if="!isMobile">
      <!--全屏 -->
      <div class="setting-item" @click="toggle">
        <svg-icon
          :icon-class="isFullscreen ? 'fullscreen-exit' : 'fullscreen'"
        />
      </div>

      <!-- 布局大小 -->
      <el-tooltip
        :content="$t('sizeSelect.tooltip')"
        effect="dark"
        placement="bottom"
      >
        <size-select class="setting-item" />
      </el-tooltip>

      <!-- 语言选择 -->
      <lang-select class="setting-item" />
    </template>

    <el-tooltip
      :content="themeTooltip"
      effect="dark"
      placement="bottom"
    >
      <button
        class="setting-item theme-toggle"
        type="button"
        :aria-label="themeTooltip"
        @click="toggleTheme"
      >
        <svg-icon :icon-class="isDark ? 'sunny' : 'moon'" />
      </button>
    </el-tooltip>

    <!-- 用户头像 -->
    <el-dropdown class="setting-item" trigger="click">
      <div class="flex-center h100% p10px">
        <img
          :src="userStore.user.avatar + '?imageView2/1/w/80/h/80'"
          class="rounded-full mr-10px w24px w24px"
        />
        <span>{{ userStore.user.username }}</span>
      </div>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item @click="openPasswordDialog">
            {{ $t("navbar.userset") }}
          </el-dropdown-item>
          <el-dropdown-item @click="logout">
            {{ $t("navbar.logout") }}
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <el-dialog
      v-model="passwordDialogVisible"
      :title="$t('userset.title')"
      width="420px"
      class="password-dialog"
      destroy-on-close
    >
      <el-form
        ref="passwordFormRef"
        :model="passwordForm"
        :rules="passwordRules"
        label-position="top"
        @submit.prevent
      >
        <el-form-item :label="$t('userset.newUsername')" prop="username">
          <el-input
            v-model.trim="passwordForm.username"
            autocomplete="username"
            :placeholder="$t('userset.newUsername')"
          />
        </el-form-item>
        <el-form-item :label="$t('userset.newPassword')" prop="password">
          <el-input
            v-model.trim="passwordForm.password"
            type="password"
            show-password
            autocomplete="new-password"
            :placeholder="$t('userset.newPassword')"
          />
        </el-form-item>
        <el-form-item label="确认新密码" prop="confirmPassword">
          <el-input
            v-model.trim="passwordForm.confirmPassword"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="请再次输入新密码"
            @keyup.enter="submitPasswordChange"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="passwordDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="passwordSubmitting"
          @click="submitPasswordChange"
        >
          确定
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
<script setup lang="ts">
import { useAppStore, useSettingsStore, useUserStore } from "@/store";
import { DeviceEnum } from "@/enums/DeviceEnum";
import { ThemeEnum } from "@/enums/ThemeEnum";
import { updateUserPassword } from "@/api/user";

const appStore = useAppStore();
const settingsStore = useSettingsStore();
const userStore = useUserStore();

const route = useRoute();
const router = useRouter();

const isMobile = computed(() => appStore.device === DeviceEnum.MOBILE);
const isDark = computed(() => settingsStore.effectiveTheme === ThemeEnum.DARK);
const themeTooltip = computed(() => {
  if (settingsStore.theme === ThemeEnum.LIGHT) return "当前日间，点击切换夜间";
  if (settingsStore.theme === ThemeEnum.DARK)
    return "当前夜间，点击切换跟随系统";
  return "当前跟随系统，点击切换日间";
});

const { isFullscreen, toggle } = useFullscreen();
const { t } = useI18n();
const passwordDialogVisible = ref(false);
const passwordSubmitting = ref(false);
const passwordFormRef = ref();
const passwordForm = reactive({
  username: "",
  password: "",
  confirmPassword: "",
});
const passwordRules = {
  username: [
    { required: true, message: t("userset.message.xx1"), trigger: "blur" },
  ],
  password: [
    { required: true, message: t("userset.message.xx1"), trigger: "blur" },
    { min: 6, message: t("userset.message.xx2"), trigger: "blur" },
  ],
  confirmPassword: [
    { required: true, message: "请再次输入新密码", trigger: "blur" },
    {
      validator: (
        _rule: unknown,
        value: string,
        callback: (error?: Error) => void
      ) => {
        if (value !== passwordForm.password) {
          callback(new Error("两次输入的密码不一致"));
          return;
        }
        callback();
      },
      trigger: "blur",
    },
  ],
};

function toggleTheme() {
  const nextTheme =
    settingsStore.theme === ThemeEnum.LIGHT
      ? ThemeEnum.DARK
      : settingsStore.theme === ThemeEnum.DARK
        ? ThemeEnum.AUTO
        : ThemeEnum.LIGHT;
  settingsStore.changeTheme(nextTheme);
}

function openPasswordDialog() {
  passwordForm.username = userStore.user.username || "";
  passwordForm.password = "";
  passwordForm.confirmPassword = "";
  passwordDialogVisible.value = true;
  nextTick(() => passwordFormRef.value?.clearValidate?.());
}

async function submitPasswordChange() {
  const valid = await passwordFormRef.value?.validate?.().catch(() => false);
  if (!valid) return;
  passwordSubmitting.value = true;
  try {
    await updateUserPassword({
      username: passwordForm.username.trim(),
      password: passwordForm.password.trim(),
    });
    ElMessage.success("密码修改成功，请重新登录");
    passwordDialogVisible.value = false;
    await userStore.resetToken();
    router.push(`/login?redirect=${route.fullPath}`);
  } finally {
    passwordSubmitting.value = false;
  }
}

/**
 * 注销
 */
function logout() {
  ElMessageBox.confirm("确定注销并退出系统吗？", "提示", {
    confirmButtonText: "确定",
    cancelButtonText: "取消",
    type: "warning",
    lockScroll: false,
  }).then(() => {
    userStore.logout().then(() => {
      router.push(`/login?redirect=${route.fullPath}`);
    });
  });
}
</script>
<style lang="scss" scoped>
.setting-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  height: $navbar-height;
  color: var(--el-text-color);
  cursor: pointer;

  &:hover {
    background: var(--el-fill-color-light);
  }
}

.theme-toggle {
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
}

.dark .setting-item:hover {
  background: rgb(255 255 255 / 20%);
}

:deep(.password-dialog) {
  max-width: calc(100vw - 32px);
}

@media (max-width: 640px) {
  .setting-item {
    min-width: 34px;
    color: var(--el-text-color-primary);

    &:hover {
      background: rgb(255 255 255 / 8%);
    }
  }

  html.dark .setting-item {
    color: #d8dee9;
  }

  .setting-item :deep(span) {
    max-width: 54px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
