<template>
  <main class="app-main">
    <router-view v-slot="{ Component, route }">
      <!-- The existing route metadata marks the management pages as cacheable.
           Keep their UI instance after the first visit so menu switches do not
           recreate a table and refetch its initial data every time. -->
      <KeepAlive>
        <component v-if="route.meta.keepAlive" :is="Component" :key="route.path" />
      </KeepAlive>
      <component v-if="!route.meta.keepAlive" :is="Component" :key="route.path" />
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
