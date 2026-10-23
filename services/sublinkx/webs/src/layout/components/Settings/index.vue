<template>
  <el-drawer
    v-model="settingsVisible"
    size="300"
    :title="$t('settings.project')"
  >
    <el-divider>{{ $t("settings.theme") }}</el-divider>

    <el-radio-group
      v-model="themeMode"
      class="theme-mode-group"
      @change="changeTheme"
    >
      <el-radio-button :label="ThemeEnum.LIGHT">日间</el-radio-button>
      <el-radio-button :label="ThemeEnum.DARK">夜间</el-radio-button>
      <el-radio-button :label="ThemeEnum.AUTO">跟随系统</el-radio-button>
    </el-radio-group>

    <el-divider>{{ $t("settings.interface") }}</el-divider>

    <div class="settings-option">
      <span class="text-xs">{{ $t("settings.themeColor") }}</span>
      <ThemeColorPicker
        v-model="settingsStore.themeColor"
        @update:model-value="changeThemeColor"
      />
    </div>

    <div class="settings-option">
      <span class="text-xs">{{ $t("settings.tagsView") }}</span>
      <el-switch v-model="settingsStore.tagsView" />
    </div>

    <div class="settings-option">
      <span class="text-xs">{{ $t("settings.fixedHeader") }}</span>
      <el-switch v-model="settingsStore.fixedHeader" />
    </div>

    <div class="settings-option">
      <span class="text-xs">{{ $t("settings.sidebarLogo") }}</span>
      <el-switch v-model="settingsStore.sidebarLogo" />
    </div>

    <div class="settings-option">
      <span class="text-xs">{{ $t("settings.watermark") }}</span>
      <el-switch v-model="settingsStore.watermarkEnabled" />
    </div>

    <el-divider>{{ $t("settings.navigation") }}</el-divider>

    <LayoutSelect
      v-model="settingsStore.layout"
      @update:model-value="changeLayout"
    />
  </el-drawer>
</template>

<script setup lang="ts">
import { useSettingsStore, usePermissionStore, useAppStore } from "@/store";
import { LayoutEnum } from "@/enums/LayoutEnum";
import { ThemeEnum } from "@/enums/ThemeEnum";

const route = useRoute();
const appStore = useAppStore();
const settingsStore = useSettingsStore();
const permissionStore = usePermissionStore();

const settingsVisible = computed({
  get() {
    return settingsStore.settingsVisible;
  },
  set() {
    settingsStore.settingsVisible = false;
  },
});

/**
 * 切换主题颜色
 */
function changeThemeColor(color: string) {
  settingsStore.changeThemeColor(color);
}

/**
 * 切换主题
 */
const themeMode = computed({
  get: () => settingsStore.theme,
  set: (value: string) => settingsStore.changeTheme(value),
});
const changeTheme = (val: any) => {
  settingsStore.changeTheme(val);
};

/**
 * 切换布局
 */
function changeLayout(layout: string) {
  settingsStore.changeLayout(layout);
  if (layout === LayoutEnum.MIX) {
    route.name && againActiveTop(route.name as string);
  } else if (layout === LayoutEnum.TOP) {
    appStore.openSideBar();
  }
}

function againActiveTop(newVal: string) {
  const parent = findOutermostParent(permissionStore.routes, newVal);
  if (appStore.activeTopMenu !== parent.path) {
    appStore.activeTopMenu(parent.path);
  }
}

function findOutermostParent(tree: any[], findName: string) {
  let parentMap: any = {};

  function buildParentMap(node: any, parent: any) {
    parentMap[node.name] = parent;

    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        buildParentMap(node.children[i], node);
      }
    }
  }

  for (let i = 0; i < tree.length; i++) {
    buildParentMap(tree[i], null);
  }

  let currentNode = parentMap[findName];
  while (currentNode) {
    if (!parentMap[currentNode.name]) {
      return currentNode;
    }
    currentNode = parentMap[currentNode.name];
  }

  return null;
}
</script>

<style lang="scss" scoped>
.settings-option {
  @apply py-1 flex-x-between;
}

.theme-mode-group {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  width: 100%;
}

.theme-mode-group :deep(.el-radio-button__inner) {
  width: 100%;
}
</style>
