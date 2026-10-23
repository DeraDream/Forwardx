<template>
  <main class="login-page">
    <div class="login-toolbar">
      <el-switch
        v-model="isDark"
        inline-prompt
        :active-icon="Moon"
        :inactive-icon="Sunny"
        @change="toggleTheme"
      />
      <lang-select />
    </div>

    <section class="login-panel">
      <header class="login-header">
        <img :src="logo" alt="" class="login-logo" />
        <div>
          <h1>{{ defaultSettings.title }}</h1>
          <p>节点与订阅管理</p>
        </div>
        <span v-if="version" class="version">v{{ version }}</span>
      </header>

      <el-form
        ref="loginFormRef"
        :model="loginData"
        :rules="loginRules"
        class="login-form"
        label-position="top"
      >
        <el-form-item prop="username" :label="$t('login.username')">
          <el-input
            ref="username"
            v-model="loginData.username"
            :placeholder="$t('login.username')"
            name="username"
            size="large"
            :prefix-icon="User"
          />
        </el-form-item>

        <el-form-item prop="password" :label="$t('login.password')">
          <el-tooltip
            :visible="isCapslock"
            :content="$t('login.capsLock')"
            placement="right"
          >
            <el-input
              v-model="loginData.password"
              :placeholder="$t('login.password')"
              type="password"
              name="password"
              size="large"
              :prefix-icon="Lock"
              show-password
              @keyup="checkCapslock"
              @keyup.enter="handleLogin"
            />
          </el-tooltip>
        </el-form-item>

        <el-button
          :loading="loading"
          type="primary"
          size="large"
          class="login-button"
          @click.prevent="handleLogin"
        >
          {{ $t("login.login") }}
        </el-button>
      </el-form>
    </section>
  </main>
</template>

<script setup lang="ts">
import { useSettingsStore, useUserStore } from "@/store";
import { GetVersion } from "@/api/auth";
import { LoginData } from "@/api/auth/types";
import { Lock, Moon, Sunny, User } from "@element-plus/icons-vue";
import { LocationQuery, LocationQueryValue, useRoute } from "vue-router";
import router from "@/router";
import defaultSettings from "@/settings";
import { ThemeEnum } from "@/enums/ThemeEnum";

const logo = new URL("../../assets/logo.png", import.meta.url).href;
const version = ref(defaultSettings.version);
const userStore = useUserStore();
const settingsStore = useSettingsStore();
const { t } = useI18n();
const route = useRoute();

const isDark = computed({
  get: () => settingsStore.effectiveTheme === ThemeEnum.DARK,
  set: (value: boolean) =>
    settingsStore.changeTheme(value ? ThemeEnum.DARK : ThemeEnum.LIGHT),
});
const loading = ref(false);
const isCapslock = ref(false);
const loginFormRef = ref(ElForm);
const loginData = ref<LoginData>({
  username: "",
  password: "",
});

const loginRules = computed(() => ({
  username: [
    {
      required: true,
      trigger: "blur",
      message: t("login.message.username.required"),
    },
  ],
  password: [
    {
      required: true,
      trigger: "blur",
      message: t("login.message.password.required"),
    },
    {
      min: 6,
      trigger: "blur",
      message: t("login.message.password.min"),
    },
  ],
}));

function handleLogin() {
  loginFormRef.value.validate((valid: boolean) => {
    if (!valid) return;

    loading.value = true;
    userStore
      .login(loginData.value)
      .then(() => {
        const query: LocationQuery = route.query;
        const redirect = (query.redirect as LocationQueryValue) ?? "/";
        const otherQueryParams = Object.keys(query).reduce(
          (acc: LocationQuery, key: string) => {
            if (key !== "redirect") acc[key] = query[key];
            return acc;
          },
          {}
        );
        router.push({ path: redirect, query: otherQueryParams });
      })
      .finally(() => {
        loading.value = false;
      });
  });
}

function toggleTheme() {
  settingsStore.changeTheme(isDark.value ? ThemeEnum.DARK : ThemeEnum.LIGHT);
}

function checkCapslock(event: KeyboardEvent) {
  if (event instanceof KeyboardEvent) {
    isCapslock.value = event.getModifierState("CapsLock");
  }
}

onMounted(() => {
  GetVersion().then(({ data }) => {
    version.value = data;
  }).catch(() => undefined);
});
</script>

<style lang="scss" scoped>
.login-page {
  position: relative;
  display: grid;
  min-height: 100%;
  padding: 32px;
  background: #f4f6f8;
  place-items: center;
}

.login-toolbar {
  position: absolute;
  top: 24px;
  right: 24px;
  display: flex;
  gap: 12px;
  align-items: center;
}

.login-panel {
  width: min(420px, 100%);
  padding: 36px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
}

.login-header {
  position: relative;
  display: flex;
  gap: 14px;
  align-items: center;
  margin-bottom: 32px;
}

.login-logo {
  width: 44px;
  height: 44px;
}

.login-header h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 650;
  letter-spacing: 0;
}

.login-header p {
  margin: 3px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.version {
  flex-shrink: 0;
  align-self: flex-start;
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

.login-form :deep(.el-form-item__label) {
  padding: 0 0 6px;
  font-weight: 500;
}

.login-form :deep(.el-input__wrapper) {
  border-radius: 4px;
  box-shadow: 0 0 0 1px var(--el-border-color) inset;
}

.login-button {
  width: 100%;
  margin-top: 8px;
  border-radius: 4px;
}

html.dark .login-page {
  background: #15171a;
}

@media (max-width: 640px) {
  .login-page {
    padding: 20px;
  }

  .login-toolbar {
    top: 16px;
    right: 16px;
  }

  .login-panel {
    padding: 28px 22px;
  }
}
</style>
