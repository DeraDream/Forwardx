<template>
  <div class="app-shell" :class="classObj">
    <Sidebar v-if="!embedded && !classObj.mobile" class="sidebar-container" />

    <div class="main-container">
      <NavBar v-if="!embedded" class="fixed-header" />
      <AppMain />
    </div>
    <MobileTabBar v-if="!embedded && classObj.mobile" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useAppStore, useSettingsStore } from "@/store";
import { DeviceEnum } from "@/enums/DeviceEnum";
import { ThemeEnum } from "@/enums/ThemeEnum";
import MobileTabBar from "./components/MobileTabBar/index.vue";

const appStore = useAppStore();
const settingsStore = useSettingsStore();
const width = useWindowSize().width;
const MOBILE_WIDTH = 992;
const embedded = new URLSearchParams(window.location.search).has("__forwardx_embed");
let overlayObserver: MutationObserver | undefined;
let forwardedBackgroundVideo: HTMLVideoElement | undefined;

function syncForwardXTheme(value: unknown) {
  if (!embedded || (value !== ThemeEnum.DARK && value !== ThemeEnum.LIGHT)) return;
  settingsStore.changeTheme(value);
}

function syncForwardXAppearance(value: any) {
  if (!embedded || !value || typeof value !== "object") return;
  syncForwardXTheme(value.theme);

  const root = document.documentElement;
  const colors = value.colors && typeof value.colors === "object" ? value.colors : {};
  for (const [name, color] of Object.entries(colors)) {
    if (typeof color === "string" && color) root.style.setProperty(`--forwardx-${name}`, color);
  }

  const background = value.background && typeof value.background === "object" ? value.background : {};
  const url = typeof background.url === "string" ? background.url : "";
  const opacity = Math.min(1, Math.max(0, Number(background.opacity) || 0));
  const blur = Math.min(32, Math.max(0, Number(background.blur) || 0));
  const isVideo = background.source === "url" && background.urlType === "video" && !!url;
  const hasImage = background.source !== "none" && !isVideo && !!url;

  root.style.setProperty("--forwardx-background-opacity", String(opacity));
  root.style.setProperty("--forwardx-background-blur", `${blur}px`);
  root.style.setProperty("--forwardx-background-image", hasImage ? `url(${JSON.stringify(url)})` : "none");
  root.toggleAttribute("data-forwardx-background", hasImage || isVideo);

  if (isVideo) {
    if (!forwardedBackgroundVideo) {
      forwardedBackgroundVideo = document.createElement("video");
      forwardedBackgroundVideo.className = "sublink-forwardx-background-video";
      forwardedBackgroundVideo.autoplay = true;
      forwardedBackgroundVideo.muted = true;
      forwardedBackgroundVideo.loop = true;
      forwardedBackgroundVideo.playsInline = true;
      document.body.prepend(forwardedBackgroundVideo);
    }
    if (forwardedBackgroundVideo.src !== new URL(url, window.location.href).href) forwardedBackgroundVideo.src = url;
  } else {
    forwardedBackgroundVideo?.remove();
    forwardedBackgroundVideo = undefined;
  }
}

const classObj = computed(() => ({
  embedded,
  hideSidebar: !appStore.sidebar.opened,
  openSidebar: appStore.sidebar.opened,
  mobile: appStore.device === DeviceEnum.MOBILE,
}));

onMounted(() => {
  if (!embedded) return;
  document.documentElement.classList.add("sublink-embedded");
  syncForwardXTheme(new URLSearchParams(window.location.search).get("forwardx_theme"));

  // Element Plus teleports dialogs to body. Tell the ForwardX parent whenever
  // one is present so it can elevate this iframe above its own chrome.
  let hasUserInteracted = false;
  const reportModalState = () => {
    const hasVisibleModal = Array.from(
      document.querySelectorAll<HTMLElement>(".el-overlay"),
    ).some((overlay) => {
      // Selects, tooltips and other floating widgets also use overlay nodes.
      // Only real dialogs and confirmation boxes should cover ForwardX.
      const modal = overlay.querySelector<HTMLElement>(".el-dialog, .el-message-box");
      return !!modal && getComputedStyle(overlay).display !== "none" && getComputedStyle(modal).display !== "none";
    });
    window.parent.postMessage({
      source: "sublinkx",
      type: "modal",
      // Several pages mount hidden dialog shells during initial render. They
      // are not user-visible dialogs and must never hide ForwardX's tab bar.
      open: hasUserInteracted && hasVisibleModal,
    }, window.location.origin);
  };
  document.addEventListener("pointerdown", () => {
    hasUserInteracted = true;
    reportModalState();
  }, { capture: true, once: true });
  overlayObserver = new MutationObserver(reportModalState);
  overlayObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  reportModalState();

  window.addEventListener("message", onForwardXMessage);
});

function onForwardXMessage(event: MessageEvent) {
  if (event.origin !== window.location.origin || event.source !== window.parent) return;
  if (event.data?.source === "forwardx" && event.data?.type === "appearance") {
    syncForwardXAppearance(event.data);
  } else if (event.data?.source === "forwardx" && event.data?.type === "theme") {
    syncForwardXTheme(event.data.theme);
  }
}

onUnmounted(() => {
  if (!embedded) return;
  overlayObserver?.disconnect();
  forwardedBackgroundVideo?.remove();
  forwardedBackgroundVideo = undefined;
  window.removeEventListener("message", onForwardXMessage);
  document.documentElement.classList.remove("sublink-embedded");
});

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

.embedded {
  .main-container {
    width: 100%;
    min-height: 100%;
    margin-left: 0;
  }

  :deep(.app-main) {
    min-height: 100%;
    padding-top: 0;
  }
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
