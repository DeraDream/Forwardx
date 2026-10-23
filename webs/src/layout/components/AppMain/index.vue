<template>
  <main class="app-main">
    <router-view v-slot="{ Component, route }">
      <component :is="Component" :key="route.path" />
    </router-view>
  </main>
</template>

<style lang="scss" scoped>
.app-main {
  width: 100%;
  min-width: 0;
  min-height: 100vh;
  padding-top: $navbar-height;
  overflow: hidden;
  background: var(--el-bg-color-page);
}
</style>
