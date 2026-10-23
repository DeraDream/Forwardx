<template>
  <div class="sidebar">
    <SidebarLogo :collapse="!appStore.sidebar.opened" />
    <el-scrollbar>
      <SidebarMenu :menu-list="permissionStore.routes" base-path="" />
    </el-scrollbar>
  </div>
</template>

<script setup lang="ts">
import { usePermissionStore, useAppStore } from "@/store";

const appStore = useAppStore();
const permissionStore = usePermissionStore();
</script>

<style lang="scss" scoped>
.sidebar {
  height: 100%;
}

.el-scrollbar {
  height: calc(100vh - $navbar-height);
}

:deep(.el-menu) {
  padding: 12px 10px;
  background: transparent;
}

:deep(.el-menu-item),
:deep(.el-sub-menu__title) {
  height: 44px;
  margin-bottom: 4px;
  color: $menu-text;
  border-radius: 4px;
}

:deep(.el-menu-item:hover),
:deep(.el-sub-menu__title:hover) {
  color: var(--el-text-color-primary);
  background: $menu-hover;
}

:deep(.el-menu-item.is-active) {
  color: $menu-active-text;
  background: #e8f0ff;
}

:deep(.el-menu-item.is-active::before) {
  position: absolute;
  top: 10px;
  bottom: 10px;
  left: 0;
  width: 3px;
  content: "";
  background: var(--el-color-primary);
}

html.dark :deep(.el-menu-item.is-active) {
  color: #eaf3ff;
  background: linear-gradient(90deg, rgb(9 105 255 / 26%), #151b26);
}

html.dark :deep(.el-menu-item.is-active .svg-icon) {
  color: #58a6ff;
}
</style>
