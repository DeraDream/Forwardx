<script setup lang="ts">
type SourceMode = "local" | "managed" | "url";
type LocalTemplate = { file: string };
type ManagedTemplate = { file: string; type: string };
const props = defineProps<{
  modelValue: string;
  mode: SourceMode;
  label: string;
  localTemplates: LocalTemplate[];
  managedTemplates: ManagedTemplate[];
}>();
const emit = defineEmits<{ "update:modelValue": [value: string]; "update:mode": [value: SourceMode] }>();
function choose(source: "local" | "managed", checked: boolean | string | number) {
  // The checkboxes intentionally behave as a radio choice: one source is
  // always active, and selecting either source deselects the other.
  if (!checked) return;
  emit("update:mode", source);
  const candidates = source === "local" ? props.localTemplates : props.managedTemplates;
  const prefix = source === "local" ? "./template/" : "./rule_templates/";
  const alreadyFromSource = props.modelValue.startsWith(prefix);
  emit("update:modelValue", alreadyFromSource ? props.modelValue : candidates[0] ? `${prefix}${candidates[0].file}` : "");
}
</script>

<template>
  <div class="template-source-picker">
    <div v-if="mode === 'url'" class="source-url">
      <el-input :model-value="modelValue" :placeholder="`输入 ${label} 模板 URL`" @update:model-value="emit('update:modelValue', String($event))" />
      <el-button plain @click="emit('update:mode', 'local')">选择本地模板</el-button>
    </div>
    <div v-else class="source-columns">
      <section class="source-column" :class="{ active: mode === 'local' }">
        <el-checkbox :model-value="mode === 'local'" @change="choose('local', $event)">原模板列表</el-checkbox>
        <el-select :model-value="modelValue" :disabled="mode !== 'local'" :placeholder="`选择 ${label} 模板`" @update:model-value="emit('update:modelValue', String($event))">
          <el-option v-for="item in localTemplates" :key="item.file" :label="item.file" :value="`./template/${item.file}`" />
        </el-select>
      </section>
      <section class="source-column" :class="{ active: mode === 'managed' }">
        <el-checkbox :model-value="mode === 'managed'" @change="choose('managed', $event)">模板管理</el-checkbox>
        <el-select :model-value="modelValue" :disabled="mode !== 'managed'" :placeholder="managedTemplates.length ? `选择 ${label} 模板` : '暂无兼容的模板管理模板'" @update:model-value="emit('update:modelValue', String($event))">
          <el-option v-for="item in managedTemplates" :key="item.file" :label="item.file" :value="`./rule_templates/${item.file}`" />
        </el-select>
      </section>
    </div>
    <el-button link type="primary" class="url-switch" @click="emit('update:mode', 'url')">使用 URL 模板</el-button>
  </div>
</template>

<style scoped>
.template-source-picker{display:grid;gap:10px}.source-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.source-column{display:grid;gap:8px;padding:12px;border:1px solid var(--el-border-color-lighter);border-radius:4px;opacity:.62;transition:border-color .18s,opacity .18s}.source-column.active{border-color:var(--el-color-primary);opacity:1}.source-column .el-select{width:100%}.source-url{display:flex;gap:10px}.source-url .el-input{flex:1}.url-switch{justify-self:start}@media(max-width:720px){.source-columns{grid-template-columns:1fr}.source-url{flex-direction:column}}
</style>
