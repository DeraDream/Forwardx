<template>
  <!-- 顶部导航栏 -->
  <div class="navbar-container">
    <!-- 导航栏左侧 -->
    <NavbarLeft />
    <!-- 导航栏右侧 -->
    <NavbarRight />
  </div>
</template>

<style lang="scss" scoped>
.navbar-container {
  @apply flex-x-between;

  height: $navbar-height;
  min-width: 0;
  padding-right: 8px;
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color-lighter);
}

@media (max-width: 640px) {
  .navbar-container {
    padding-right: 4px;
    background: #ffffff;
    border-bottom-color: #e5e7eb;
  }

  html.dark .navbar-container {
    background: #05070b;
    border-bottom-color: #202631;
  }
}
</style>
