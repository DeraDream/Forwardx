import router from "@/router";
import { useUserStore, usePermissionStore } from "@/store";
import NProgress from "@/utils/nprogress";
import { RouteRecordRaw } from "vue-router";

// Starting the bar on every in-app navigation made cached page switches feel
// slower than they are. Keep feedback for real work (initial permissions,
// lazy chunks, or a slow request), but do not flash it for an instant switch.
let progressTimer: ReturnType<typeof setTimeout> | undefined;
const PROGRESS_DELAY_MS = 160;
const isForwardXEmbed = new URLSearchParams(window.location.search).has("__forwardx_embed");

function scheduleProgress() {
  // ForwardX already owns the outer navigation. On the first embedded load,
  // SublinkX registers its dynamic routes asynchronously and its own bar would
  // flash beneath the ForwardX shell despite there being no user action.
  if (isForwardXEmbed) return;
  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    progressTimer = undefined;
    NProgress.start();
  }, PROGRESS_DELAY_MS);
}

function finishProgress() {
  if (progressTimer) {
    clearTimeout(progressTimer);
    progressTimer = undefined;
  }
  if (!isForwardXEmbed) NProgress.done();
}

export function setupPermission() {
  // 白名单路由
  const whiteList = ["/login"];

  router.beforeEach(async (to, from, next) => {
    scheduleProgress();
    const hasToken = localStorage.getItem("accessToken");
    if (hasToken) {
      if (to.path === "/login") {
        // 如果已登录，跳转首页
        next({ path: "/" });
        finishProgress();
      } else {
        const userStore = useUserStore();
        const hasRoles =
          userStore.user.roles && userStore.user.roles.length > 0;
        if (hasRoles) {
          // 未匹配到任何路由，跳转404
          if (to.matched.length === 0) {
            from.name ? next({ name: from.name }) : next("/404");
          } else {
            next();
          }
        } else {
          const permissionStore = usePermissionStore();
          try {
            const { roles } = await userStore.getUserInfo();
            const accessRoutes = await permissionStore.generateRoutes(roles);
            accessRoutes.forEach((route: RouteRecordRaw) => {
              router.addRoute(route);
            });
            next({ ...to, replace: true });
          } catch (error) {
            // 移除 token 并跳转登录页
            await userStore.resetToken();
            next(`/login?redirect=${to.path}`);
            finishProgress();
          }
        }
      }
    } else {
      // 未登录可以访问白名单页面
      if (whiteList.indexOf(to.path) !== -1) {
        next();
      } else {
        next(`/login?redirect=${to.path}`);
        finishProgress();
      }
    }
  });

  router.afterEach(() => {
    finishProgress();
  });
}
