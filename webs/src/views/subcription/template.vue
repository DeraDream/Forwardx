<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import YamlEditor from "@/components/YamlEditor/index.vue";
import { AddTemp, DelTemp, getTemp, UpdateTemp } from "@/api/subcription/temp";
import { formatBeijingTime } from "@/utils/time";
import { useDraggableTableRows } from "@/utils/table-drag";
import { useAppStore } from "@/store";
import { DeviceEnum } from "@/enums/DeviceEnum";
import { LineCounter, parseDocument } from "yaml";

interface Temp {
  file: string;
  text: string;
  create_date: string;
}

const tableData = ref<Temp[]>([]);
const appStore = useAppStore();
const isMobile = computed(() => appStore.device === DeviceEnum.MOBILE);
const Tempoldname = ref("");
const Tempname = ref("");
const TempText = ref("");
const dialogVisible = ref(false);
const table = ref();
const TempTitle = ref("");
const editorMode = ref<"add" | "edit" | "import">("add");
const fileInput = ref<HTMLInputElement>();
const isDragging = ref(false);
const yamlEditor = ref<InstanceType<typeof YamlEditor>>();
const yamlValidationError = ref("");

async function gettemps() {
  const { data } = await getTemp();
  tableData.value = data;
}

onMounted(gettemps);

const handleAddTemp = () => {
  editorMode.value = "add";
  TempTitle.value = "添加模板";
  Tempname.value = "";
  Tempoldname.value = "";
  TempText.value = "";
  yamlValidationError.value = "";
  dialogVisible.value = true;
};

const addtemp = async () => {
  const filename = normalizeTemplateFilename(Tempname.value, TempText.value);
  if (!filename) {
    ElMessage.warning("请输入模板文件名");
    return;
  }
  if (!TempText.value.trim()) {
    ElMessage.warning("模板内容不能为空");
    return;
  }
  if (!validateCurrentTemplate(filename)) {
    return;
  }

  if (editorMode.value === "edit") {
    await UpdateTemp({
      filename,
      oldname: Tempoldname.value.trim(),
      text: TempText.value,
    });
    ElMessage.success("更新成功");
  } else {
    await AddTemp({
      filename,
      text: TempText.value,
    });
    ElMessage.success(editorMode.value === "import" ? "导入成功" : "添加成功");
  }

  await gettemps();
  Tempname.value = "";
  Tempoldname.value = "";
  TempText.value = "";
  yamlValidationError.value = "";
  dialogVisible.value = false;
};

const multipleSelection = ref<Temp[]>([]);
const handleSelectionChange = (val: Temp[]) => {
  multipleSelection.value = val;
};

const normalizeTemplateFilename = (filename: string, text = "") => {
  const name = (filename || "").trim();
  if (!name) {
    return "";
  }
  if (/\.[^./\\]+$/.test(name)) {
    return name;
  }
  const lowerName = name.toLowerCase();
  const lowerText = text.toLowerCase();
  if (
    lowerName.includes("surge") ||
    lowerText.includes("[general]") ||
    lowerText.includes("[proxy]")
  ) {
    return `${name}.conf`;
  }
  return `${name}.yaml`;
};

const isYamlTemplateFilename = (filename: string) =>
  /\.(ya?ml)$/i.test((filename || "").trim());

const yamlErrorLine = (error: any, lineCounter: LineCounter) => {
  const linePos = error?.linePos?.[0];
  if (linePos?.line) {
    return linePos.line;
  }
  const pos = Array.isArray(error?.pos) ? error.pos[0] : undefined;
  if (typeof pos === "number") {
    return lineCounter.linePos(pos).line;
  }
  return undefined;
};

const validateYamlTemplate = (filename: string, text: string) => {
  if (!isYamlTemplateFilename(filename)) {
    return "";
  }
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const indent = lines[index].match(/^[\t ]*/)?.[0] || "";
    if (indent.includes("\t")) {
      return `第 ${index + 1} 行：YAML 缩进不能使用 Tab，请改为空格`;
    }
  }
  try {
    const lineCounter = new LineCounter();
    const doc = parseDocument(text, {
      lineCounter,
      prettyErrors: false,
      strict: true,
    });
    if (doc.errors.length > 0) {
      const error = doc.errors[0] as any;
      const line = yamlErrorLine(error, lineCounter);
      const message = String(error.message || error).trim();
      return line
        ? `第 ${line} 行：YAML 格式错误：${message}`
        : `YAML 格式错误：${message}`;
    }
  } catch (error: any) {
    const message = String(error?.message || error).trim();
    return `YAML 格式错误：${message}`;
  }
  return "";
};

const validateCurrentTemplate = (
  filename = normalizeTemplateFilename(Tempname.value, TempText.value)
) => {
  yamlValidationError.value = validateYamlTemplate(filename, TempText.value);
  if (yamlValidationError.value) {
    ElMessage.error(yamlValidationError.value);
    return false;
  }
  return true;
};

watch([Tempname, TempText], () => {
  if (!dialogVisible.value) {
    return;
  }
  const filename = normalizeTemplateFilename(Tempname.value, TempText.value);
  yamlValidationError.value = validateYamlTemplate(filename, TempText.value);
});

const selectAll = () => {
  if (isMobile.value) {
    multipleSelection.value = [...currentTableData.value];
    return;
  }
  nextTick(() => {
    tableData.value.forEach((row) => {
      table.value.toggleRowSelection(row, true);
    });
  });
};

const handleExport = (row: any) => {
  const blob = new Blob([row.text], {
    type: "application/yaml;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const downloadLink = document.createElement("a");
  downloadLink.href = url;
  downloadLink.download = normalizeTemplateFilename(row.file, row.text);
  document.body.appendChild(downloadLink);
  downloadLink.click();
  downloadLink.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const handleEdit = (row: any) => {
  editorMode.value = "edit";
  TempTitle.value = "编辑模板";
  Tempname.value = row.file;
  Tempoldname.value = row.file;
  TempText.value = row.text;
  yamlValidationError.value = "";
  dialogVisible.value = true;
};

const toggleSelection = () => {
  if (isMobile.value) {
    multipleSelection.value = [];
    return;
  }
  table.value.clearSelection();
};

const openFilePicker = () => {
  fileInput.value?.click();
};

const handleFileInputChange = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (file) {
    await previewImportFile(file);
  }
  target.value = "";
};

const handleDrop = async (event: DragEvent) => {
  isDragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (!file) {
    return;
  }
  await previewImportFile(file);
};

const previewImportFile = async (file: File) => {
  const text = await file.text();
  editorMode.value = "import";
  TempTitle.value = "导入模板预览";
  Tempname.value = normalizeTemplateFilename(file.name, text);
  Tempoldname.value = "";
  TempText.value = text;
  yamlValidationError.value = validateYamlTemplate(
    Tempname.value,
    TempText.value
  );
  dialogVisible.value = true;
  if (yamlValidationError.value) {
    ElMessage.error(yamlValidationError.value);
    return;
  }
  ElMessage.info("已读取本地文件，请检查内容，点击保存后才会真正导入");
};

const handleDel = (row: any) => {
  ElMessageBox.confirm(`你是否要删除 ${row.file} ?`, "提示", {
    confirmButtonText: "确定",
    cancelButtonText: "取消",
    type: "warning",
  }).then(async () => {
    await DelTemp({
      filename: row.file,
    });
    ElMessage({
      type: "success",
      message: "删除成功",
    });
    gettemps();
  });
};

const selectDel = () => {
  if (multipleSelection.value.length === 0) {
    return;
  }
  ElMessageBox.confirm("你是否要删除选中的模板？", "提示", {
    confirmButtonText: "确定",
    cancelButtonText: "取消",
    type: "warning",
  }).then(async () => {
    await Promise.all(
      multipleSelection.value.map((item) =>
        DelTemp({
          filename: item.file,
        })
      )
    );
    await gettemps();
    ElMessage({
      type: "success",
      message: "删除成功",
    });
  });
};

const currentPage = ref(1);
const pageSize = ref(10);
const handleSizeChange = (val: number) => {
  pageSize.value = val;
};

const handleCurrentChange = (val: number) => {
  currentPage.value = val;
};

const currentTableData = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value;
  return tableData.value.slice(start, start + pageSize.value);
});
const selectedTemplateNames = computed(
  () => new Set(multipleSelection.value.map((item) => item.file))
);
useDraggableTableRows({
  tableRef: table,
  rows: tableData,
  enabled: computed(() => !isMobile.value),
  startIndex: () => (currentPage.value - 1) * pageSize.value,
  storageKey: "sublink:templates:order",
  rowKey: (row) => row.file,
});

const formatTemplateTime = (row: Temp) => formatBeijingTime(row.create_date);
const templateKind = (row: Temp) =>
  row.file.toLowerCase().endsWith(".conf") ? "Surge" : "YAML";
const isTemplateSelected = (row: Temp) =>
  selectedTemplateNames.value.has(row.file);
const toggleMobileTemplateSelection = (row: Temp, checked: boolean) => {
  if (checked) {
    if (!isTemplateSelected(row)) {
      multipleSelection.value = [...multipleSelection.value, row];
    }
    return;
  }
  multipleSelection.value = multipleSelection.value.filter(
    (item) => item.file !== row.file
  );
};
</script>

<template>
  <div class="page-workspace mobile-page">
    <input
      ref="fileInput"
      class="hidden-file-input"
      type="file"
      accept=".yaml,.yml,.conf,.txt"
      @change="handleFileInputChange"
    />

    <el-dialog
      v-model="dialogVisible"
      class="template-editor-dialog"
      width="calc(100vw - 64px)"
      top="32px"
      :close-on-click-modal="true"
      destroy-on-close
    >
      <template #header>
        <div class="editor-dialog-heading">
          <div>
            <h2>{{ TempTitle }}</h2>
            <p>
              {{
                editorMode === "import"
                  ? "这是本地文件预览，还没有写入服务器；确认无误后点击保存模板。"
                  : "编辑 YAML 配置，右侧内容会实时同步。"
              }}
            </p>
          </div>
          <el-input
            v-model="Tempname"
            class="filename-input"
            placeholder="模板文件名，例如 config.yaml"
          >
            <template #prepend>文件名</template>
          </el-input>
        </div>
      </template>

      <el-alert
        v-if="editorMode === 'import'"
        class="import-preview-alert"
        title="当前只是导入预览"
        type="info"
        show-icon
        :closable="false"
        description="你可以先修改文件名和内容。只有点击底部“保存模板”后，模板才会真正导入。"
      />

      <el-alert
        v-if="yamlValidationError"
        class="yaml-validation-alert"
        title="YAML 格式检查未通过"
        type="error"
        show-icon
        :closable="false"
        :description="yamlValidationError"
      />

      <div class="editor-layout">
        <section class="editor-panel">
          <div class="panel-heading">
            <span>YAML 编辑</span>
            <div class="editor-heading-actions">
              <span class="panel-hint">Tab 缩进 2 个空格</span>
              <el-button
                class="search-button"
                size="small"
                @click="yamlEditor?.showSearchPanel()"
              >
                查找替换
              </el-button>
            </div>
          </div>
          <div class="editor-content">
            <YamlEditor
              ref="yamlEditor"
              v-model="TempText"
              :language="/\.(?:conf|list)$/i.test(Tempname) ? 'ini' : 'yaml'"
            />
          </div>
        </section>

        <section class="editor-panel">
          <div class="panel-heading">
            <span>实时预览</span>
            <span class="panel-hint">同步显示当前内容</span>
          </div>
          <pre
            class="yaml-preview"
          ><code>{{ TempText || "# 暂无内容" }}</code></pre>
        </section>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" @click="addtemp">保存模板</el-button>
        </div>
      </template>
    </el-dialog>

    <div class="page-heading">
      <div>
        <h1>模板列表</h1>
        <p>维护 Clash、Surge、Egern 等订阅输出模板</p>
      </div>
      <div class="heading-actions">
        <el-button class="import-file-button" @click="openFilePicker">
          导入本地文件
        </el-button>
        <el-button type="primary" @click="handleAddTemp">添加模板</el-button>
      </div>
    </div>

    <section
      class="work-surface template-drop-surface"
      :class="['mobile-app-surface', { 'is-dragging': isDragging }]"
      @dragover.prevent="isDragging = true"
      @dragleave.prevent="isDragging = false"
      @drop.prevent="handleDrop"
    >
      <div class="table-toolbar">
        <span class="record-count">共 {{ tableData.length }} 个模板</span>
        <span class="drop-hint"
          >可把 .yaml / .yml / .conf 文件拖到这里导入预览</span
        >
      </div>

      <el-table
        class="desktop-data-table"
        ref="table"
        :data="currentTableData"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" fixed width="48" />
        <el-table-column width="42" label="">
          <template #default>
            <span class="row-drag-handle" title="拖动排序">☰</span>
          </template>
        </el-table-column>
        <el-table-column prop="file" label="模板文件名" min-width="320">
          <template #default="scope">
            <span class="primary-cell">{{ scope.row.file }}</span>
          </template>
        </el-table-column>
        <el-table-column
          prop="create_date"
          label="创建时间"
          min-width="200"
          sortable
          :formatter="formatTemplateTime"
        />
        <el-table-column fixed="right" label="操作" width="190" align="right">
          <template #default="scope">
            <el-button link type="primary" @click="handleExport(scope.row)"
              >导出</el-button
            >
            <el-button link type="primary" @click="handleEdit(scope.row)"
              >编辑</el-button
            >
            <el-button link type="danger" @click="handleDel(scope.row)"
              >删除</el-button
            >
          </template>
        </el-table-column>
      </el-table>

      <div class="mobile-only-list mobile-card-list">
        <div v-if="currentTableData.length === 0" class="mobile-empty-state">
          暂无模板
        </div>
        <article
          v-for="row in currentTableData"
          :key="row.file"
          class="mobile-card"
        >
          <div class="mobile-card-top">
            <el-checkbox
              :model-value="isTemplateSelected(row)"
              @change="
                (checked) =>
                  toggleMobileTemplateSelection(row, Boolean(checked))
              "
            />
            <div class="mobile-card-title">
              <strong>{{ row.file }}</strong>
              <small>{{ formatTemplateTime(row) }}</small>
            </div>
            <span class="mobile-status">{{ templateKind(row) }}</span>
          </div>

          <div class="mobile-field">
            <span>内容预览</span>
            <code>{{ row.text || "空模板" }}</code>
          </div>

          <div class="mobile-card-actions">
            <el-button @click="handleExport(row)">导出</el-button>
            <el-button type="primary" @click="handleEdit(row)">编辑</el-button>
            <el-button type="danger" @click="handleDel(row)">删除</el-button>
          </div>
        </article>
      </div>

      <div class="drop-overlay">
        <div>
          <strong>松开文件，打开导入预览</strong>
          <span>保存前不会写入模板目录</span>
        </div>
      </div>

      <div class="table-footer">
        <div class="batch-actions">
          <el-button @click="selectAll">全选</el-button>
          <el-button @click="toggleSelection">取消选择</el-button>
          <el-button type="danger" plain @click="selectDel">批量删除</el-button>
        </div>
        <el-pagination
          class="table-pagination"
          :current-page="currentPage"
          :page-size="pageSize"
          layout="total, sizes, prev, pager, next, jumper"
          :page-sizes="[10, 20, 30, 40]"
          :total="tableData.length"
          @size-change="handleSizeChange"
          @current-change="handleCurrentChange"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.hidden-file-input {
  display: none;
}

.heading-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.record-count {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.drop-hint {
  color: var(--el-text-color-placeholder);
  font-size: 13px;
}

.primary-cell {
  font-weight: 550;
}

.template-drop-surface {
  position: relative;
  overflow: hidden;
}

.template-drop-surface.is-dragging {
  border-color: var(--el-color-primary);
  background: color-mix(
    in srgb,
    var(--el-color-primary) 7%,
    var(--el-bg-color)
  );
}

.drop-overlay {
  position: absolute;
  z-index: 5;
  inset: 12px;
  display: none;
  place-items: center;
  border: 1px dashed var(--el-color-primary);
  border-radius: 12px;
  background: color-mix(in srgb, var(--el-bg-color) 86%, transparent);
  pointer-events: none;
}

.template-drop-surface.is-dragging .drop-overlay {
  display: grid;
}

.drop-overlay div {
  display: grid;
  gap: 6px;
  padding: 20px 26px;
  border-radius: 12px;
  background: var(--el-bg-color);
  box-shadow: var(--el-box-shadow-light);
  text-align: center;
}

.drop-overlay strong {
  color: var(--el-color-primary);
  font-size: 16px;
}

.drop-overlay span {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.import-preview-alert {
  margin-bottom: 14px;
}

.yaml-validation-alert {
  margin-bottom: 14px;
}

.editor-dialog-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 32px;
  padding-right: 32px;
}

.editor-dialog-heading h2 {
  margin: 0;
  color: var(--el-text-color-primary);
  font-size: 18px;
  letter-spacing: 0;
}

.editor-dialog-heading p {
  margin: 5px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.filename-input {
  width: min(440px, 45vw);
}

.editor-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
  height: 100%;
  min-height: 440px;
}

.editor-panel {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-bg-color);
}

.panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44px;
  padding: 0 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
  font-size: 14px;
  font-weight: 600;
}

.panel-hint {
  color: var(--el-text-color-placeholder);
  font-size: 12px;
  font-weight: 400;
}

.editor-heading-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.search-button {
  font-weight: 500;
}

.editor-content {
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.yaml-preview {
  min-height: 0;
  flex: 1;
  overflow: auto;
  box-sizing: border-box;
  margin: 0;
  padding: 14px 18px;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 13px;
  line-height: 1.55;
  tab-size: 2;
  white-space: pre;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

@media (min-width: 901px) {
  :deep(.template-editor-dialog) {
    /* The overlay provides the viewport gutter. Keep the dialog itself within
       that space so its header, body, and footer do not overflow the viewport. */
    display: flex;
    box-sizing: border-box;
    height: calc(100dvh - 48px);
    min-height: 0;
    flex-direction: column;
    margin: 0 auto !important;
  }

  :deep(.template-editor-dialog .el-dialog__header),
  :deep(.template-editor-dialog .el-dialog__footer) {
    flex: none;
  }

  :deep(.template-editor-dialog .el-dialog__body) {
    display: flex;
    box-sizing: border-box;
    /* This editor intentionally fills its dialog; do not inherit the global
       body height cap that is intended for regular dialogs. */
    max-height: none;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
  }

  .editor-layout {
    height: auto;
    min-height: 0;
    flex: 1;
  }
}

@media (max-width: 900px) {
  .editor-dialog-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }

  .filename-input {
    width: 100%;
  }

  .editor-layout {
    grid-template-columns: 1fr;
    height: auto;
  }

  .editor-panel {
    height: 420px;
  }
}

@media (max-width: 640px) {
  .heading-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;
  }

  .heading-actions .el-button {
    width: 100%;
    margin-left: 0;
  }

  .heading-actions .import-file-button.el-button {
    color: #0f172a;
    background: #ffffff;
    border-color: #cbd5e1;
    box-shadow: 0 8px 18px rgb(15 23 42 / 8%);
  }

  html.dark .heading-actions .import-file-button.el-button {
    color: #d8dee9;
    background: #151820;
    border-color: #2a303b;
    box-shadow: none;
  }

  :deep(.template-editor-dialog) {
    width: min(92vw, 520px) !important;
  }

  :deep(.template-editor-dialog .el-dialog__body) {
    padding: 14px 12px;
  }

  :deep(.template-editor-dialog .el-dialog__footer) {
    padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
  }

  .editor-dialog-heading {
    padding-right: 28px;
  }

  .editor-layout {
    gap: 12px;
  }

  .editor-panel {
    height: 330px;
  }

  .panel-heading {
    min-height: 40px;
    padding: 0 12px;
  }

  .yaml-preview {
    padding: 12px;
    font-size: 12px;
  }
}
</style>
