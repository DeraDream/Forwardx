<template>
  <nav class="mobile-tabbar" aria-label="手机端主导航">
    <button
      v-for="item in tabItems"
      :key="item.path"
      class="mobile-tabbar-item"
      :class="{ active: isActive(item) }"
      type="button"
      @click="go(item.path)"
    >
      <svg-icon :icon-class="item.icon || 'menu'" />
      <span>{{ mobileTitle(item.title) }}</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { usePermissionStore } from "@/store";

interface TabItem {
  path: string;
  basePath: string;
  icon: string;
  title: string;
}

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const permissionStore = usePermissionStore();

const normalizePath = (path: string) => path.replace(/\/+/g, "/");

const visibleChildren = (children: any[] = []) =>
  children.filter((child) => !child.meta?.hidden);

const resolveChildPath = (parentPath: string, childPath: string) =>
  normalizePath(`${parentPath}/${childPath}`).replace(/\/$/, "") || "/";

const tabItems = computed<TabItem[]>(() =>
  permissionStore.routes
    .filter((item: any) => !item.meta?.hidden)
    .flatMap((item: any) => {
      const children = visibleChildren(item.children);
      if (item.meta?.alwaysShow) {
        return [
          {
            path:
              item.redirect ||
              (children[0] ? resolveChildPath(item.path, children[0].path) : item.path),
            basePath: item.path,
            icon: item.meta?.icon || children[0]?.meta?.icon || "menu",
            title: item.meta?.title || children[0]?.meta?.title || "",
          },
        ];
      }
      if (children.length > 0) {
        return children.map((child: any) => ({
          path: resolveChildPath(item.path, child.path),
          basePath: item.path,
          icon: child.meta?.icon || item.meta?.icon || "menu",
          title: child.meta?.title || item.meta?.title || "",
        }));
      }
      return [
        {
          path: item.path,
          basePath: item.path,
          icon: item.meta?.icon || "menu",
          title: item.meta?.title || "",
        },
      ];
    })
    .filter((item: TabItem) => item.title)
);

function isActive(item: TabItem) {
  return route.path === item.path || route.path.startsWith(`${item.basePath}/`);
}

function go(path: string) {
  if (route.path !== path) {
    router.push(path);
  }
}

function mobileTitle(title: string) {
  const titleMap: Record<string, string> = {
    nodesublist: "节点订阅",
    templatelist: "模板",
    settingsmenu: "设置",
    telegrambot: "机器人",
  };
  return titleMap[title] || t(`route.${title}`);
}
</script>

<style lang="scss" scoped>
.mobile-tabbar {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 30;
  display: none;
  grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
  min-height: calc(62px + env(safe-area-inset-bottom));
  padding: 6px 6px calc(6px + env(safe-area-inset-bottom));
  background: rgb(255 255 255 / 94%);
  border-top: 1px solid #e5e7eb;
  box-shadow: 0 -10px 30px rgb(15 23 42 / 10%);
  backdrop-filter: blur(14px);
}

.mobile-tabbar-item {
  display: grid;
  min-width: 0;
  min-height: 50px;
  place-items: center;
  gap: 3px;
  padding: 4px 2px;
  color: #6b7280;
  background: transparent;
  border: 0;
  border-radius: 8px;
  font: inherit;
}

.mobile-tabbar-item :deep(.svg-icon) {
  width: 19px;
  height: 19px;
}

.mobile-tabbar-item span {
  max-width: 100%;
  overflow: hidden;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-tabbar-item.active {
  color: #0969ff;
  background: rgb(9 105 255 / 10%);
}

html.dark .mobile-tabbar {
  background: rgb(5 7 11 / 94%);
  border-top-color: #202631;
  box-shadow: 0 -10px 30px rgb(0 0 0 / 42%);
}

html.dark .mobile-tabbar-item {
  color: #8b93a7;
}

html.dark .mobile-tabbar-item.active {
  color: #58a6ff;
  background: rgb(9 105 255 / 16%);
}

@media (max-width: 992px) {
  .mobile-tabbar {
    display: grid;
  }
}
</style>
