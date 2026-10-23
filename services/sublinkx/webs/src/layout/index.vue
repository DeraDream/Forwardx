<template>
  <div class="app-shell" :class="classObj">
    <Sidebar v-if="!classObj.mobile" class="sidebar-container" />

    <div class="main-container">
      <NavBar class="fixed-header" />
      <AppMain />
    </div>
    <MobileTabBar v-if="classObj.mobile" />
  </div>
</template>

<script setup lang="ts">
import { useAppStore } from "@/store";
import { DeviceEnum } from "@/enums/DeviceEnum";
import MobileTabBar from "./components/MobileTabBar/index.vue";

const appStore = useAppStore();
const width = useWindowSize().width;
const MOBILE_WIDTH = 992;

const classObj = computed(() => ({
  hideSidebar: !appStore.sidebar.opened,
  openSidebar: appStore.sidebar.opened,
  mobile: appStore.device === DeviceEnum.MOBILE,
}));

watchEffect(() => {
  if (width.value < MOBILE_WIDTH) {
    appStore.toggleDevice(DeviceEnum.MOBILE);
    appStore.closeSideBar();
  } else {
    appStore.toggleDevice(DeviceEnum.DESKTOP);
    appStore.openSideBar();
  }
});

</script>

<style lang="scss" scoped>
.app-shell {
  min-height: 100%;
  background: var(--el-bg-color-page);
}

.sidebar-container {
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 30;
  width: $sidebar-width;
  overflow: hidden;
  background: $menu-background;
  border-right: 1px solid var(--el-border-color-lighter);
  transition: width 0.2s ease;

  :deep(.el-menu) {
    border: 0;
  }
}

.main-container {
  width: calc(100% - $sidebar-width);
  min-width: 0;
  min-height: 100vh;
  margin-left: $sidebar-width;
  transition: margin-left 0.2s ease;
}

.fixed-header {
  position: fixed;
  top: 0;
  right: 0;
  left: $sidebar-width;
  z-index: 20;
  transition: left 0.2s ease;
}

.hideSidebar {
  .sidebar-container {
    width: $sidebar-width-collapsed;
  }

  .main-container {
    width: calc(100% - $sidebar-width-collapsed);
    margin-left: $sidebar-width-collapsed;
  }

  .fixed-header {
    left: $sidebar-width-collapsed;
  }
}

.mobile {
  .sidebar-container {
    width: $sidebar-width;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }

  &.openSidebar .sidebar-container {
    transform: translateX(0);
  }

  .main-container {
    width: 100%;
    margin-left: 0;
    padding-bottom: calc(74px + env(safe-area-inset-bottom));
  }

  .fixed-header {
    left: 0;
  }
}
</style>
