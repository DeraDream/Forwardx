<script setup lang="ts">
type Section = { name: string; lines: string[] };
type Group = {
  name: string;
  type: "select" | "url-test" | "fallback" | "load-balance";
  policies: string[];
  url?: string;
  interval?: string;
  tolerance?: string;
  maxTimeout?: string;
  algorithm?: string;
  extras: string[];
};
type Rule = { value: string; target: string };
const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{
  "update:modelValue": [value: string];
  error: [value: string];
}>();
const sections = ref<Section[]>([]),
  groups = ref<Group[]>([]),
  rules = ref<Rule[]>([]),
  groupNotes = ref<string[]>([]),
  ruleNotes = ref<string[]>([]),
  expandedGroups = ref<number[]>([]),
  expandedRules = ref<number[]>([]),
  expandedSections = ref<string[]>([]),
  syncing = ref(false);
let emittedValue: string | undefined;
const findSection = (name: string) =>
  sections.value.find((item) => item.name.toLowerCase() === name.toLowerCase());
function ensureSection(name: string) {
  return (
    findSection(name) ||
    (sections.value.push({ name, lines: [] }),
    sections.value[sections.value.length - 1])
  );
}
const groupTypes: Array<{ value: Group["type"]; label: string }> = [
  { value: "select", label: "手动选择" },
  { value: "url-test", label: "自动测速" },
  { value: "fallback", label: "故障转移" },
  { value: "load-balance", label: "负载均衡" },
];
const parseGroup = (line: string): Group => {
  const [name = "", ...rest] = line.split("=");
  const [type = "select", ...items] = rest
    .join("=")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const group: Group = {
    name: name.trim(),
    type: groupTypes.some((item) => item.value === type)
      ? (type as Group["type"])
      : "select",
    policies: [],
    extras: [],
  };
  for (const item of items) {
    const [key, ...value] = item.split("=");
    const setting = value.join("=").trim();
    if (!setting) group.policies.push(item);
    else if (key === "url") group.url = setting;
    else if (key === "interval") group.interval = setting;
    else if (key === "tolerance") group.tolerance = setting;
    else if (key === "max-timeout") group.maxTimeout = setting;
    else if (key === "algorithm") group.algorithm = setting;
    else group.extras.push(item);
  }
  return group;
};
const ruleModifiers = new Set([
  "no-resolve",
  "extended-matching",
  "force-remote-dns",
]);
const parseRule = (value: string): Rule => {
  const parts = value.split(",").map((part) => part.trim());
  let target = "";
  for (let index = parts.length - 1; index > 0; index--) {
    if (!ruleModifiers.has(parts[index].toLowerCase())) {
      target = parts[index];
      break;
    }
  }
  return { value, target };
};
function load(value: string) {
  const output: Section[] = [];
  let current: Section | undefined;
  for (const raw of value.replace(/\r/g, "").split("\n")) {
    const heading = raw.match(/^\s*\[([^\]]+)\]\s*$/);
    if (heading) {
      current = { name: heading[1], lines: [] };
      output.push(current);
    } else if (current) current.lines.push(raw);
  }
  if (!output.length)
    return emit("error", "Loon 配置需要 INI 分段，例如 [Proxy Group]");
  syncing.value = true;
  sections.value = output;
  const groupLines = findSection("Proxy Group")?.lines || [],
    ruleLines = findSection("Rule")?.lines || [];
  groupNotes.value = groupLines.filter(
    (line) => !line.includes("=") || /^\s*[#;]/.test(line)
  );
  ruleNotes.value = ruleLines.filter((line) => !line || /^\s*[#;]/.test(line));
  groups.value = groupLines
    .filter((line) => line.includes("=") && !/^\s*[#;]/.test(line))
    .map(parseGroup);
  rules.value = ruleLines
    .filter((line) => line && !/^\s*[#;]/.test(line))
    .map(parseRule);
  expandedGroups.value = [];
  expandedRules.value = [];
  expandedSections.value = [];
  syncing.value = false;
}
function write() {
  if (syncing.value) return;
  const proxyGroups = findSection("Proxy Group");
  if (proxyGroups)
    proxyGroups.lines = [
      ...groupNotes.value,
      ...groups.value.map((group) => {
        const settings = [
          ...group.policies,
          ...(group.url ? [`url=${group.url}`] : []),
          ...(group.interval ? [`interval=${group.interval}`] : []),
          ...(group.tolerance ? [`tolerance=${group.tolerance}`] : []),
          ...(group.maxTimeout ? [`max-timeout=${group.maxTimeout}`] : []),
          ...(group.algorithm ? [`algorithm=${group.algorithm}`] : []),
          ...group.extras,
        ];
        return `${group.name} = ${[group.type, ...settings].join(",")}`.trim();
      }),
    ];
  const ruleSection = findSection("Rule");
  if (ruleSection)
    ruleSection.lines = [
      ...ruleNotes.value,
      ...rules.value.map((rule) => rule.value),
    ];
  const value =
    sections.value
      .map((section) =>
        `[${section.name}]\n${section.lines.join("\n")}`.trimEnd()
      )
      .join("\n\n") + "\n";
  if (value !== props.modelValue) {
    emittedValue = value;
    emit("update:modelValue", value);
  }
}
const toggleGroup = (index: number) =>
  (expandedGroups.value = expandedGroups.value.includes(index)
    ? expandedGroups.value.filter((item) => item !== index)
    : [...expandedGroups.value, index]);
const toggleRuleList = (index: number) =>
  (expandedRules.value = expandedRules.value.includes(index)
    ? expandedRules.value.filter((item) => item !== index)
    : [...expandedRules.value, index]);
const toggleSection = (name: string) =>
  (expandedSections.value = expandedSections.value.includes(name)
    ? expandedSections.value.filter((item) => item !== name)
    : [...expandedSections.value, name]);
const groupRules = (name: string) =>
  rules.value
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.target === name);
function addGroup() {
  ensureSection("Proxy Group");
  groups.value.push({
    name: `策略组 ${groups.value.length + 1}`,
    type: "select",
    policies: ["__LOON_ALL_NODES__", "DIRECT"],
    extras: [],
  });
}
function addRule(target: string) {
  ensureSection("Rule");
  rules.value.push(parseRule(`DOMAIN-SUFFIX,example.com,${target}`));
}
function updateRule(rule: Rule, value: string) {
  Object.assign(rule, parseRule(value));
}
function moveGroup(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= groups.value.length) return;
  const [group] = groups.value.splice(index, 1);
  groups.value.splice(target, 0, group);
}
watch(
  () => props.modelValue,
  (value) => {
    if (value === emittedValue) {
      emittedValue = undefined;
      return;
    }
    load(value);
  },
  { immediate: true }
);
watch([sections, groups, rules], write, { deep: true });
</script>
<template>
  <section class="loon-editor">
    <header>
      <div>
        <strong
          >Loon 策略组 <em>{{ groups.length }}</em></strong
        ><small>按策略组管理成员与流量规则</small>
      </div>
      <el-button size="small" type="primary" @click="addGroup"
        >添加策略组</el-button
      >
    </header>
    <el-scrollbar class="body"
      ><div class="content">
        <section class="proxy-groups">
          <div
            v-for="(group, index) in groups"
            :key="index"
            class="card"
            :class="{ expanded: expandedGroups.includes(index) }"
          >
            <div class="card-head">
              <button @click="toggleGroup(index)">
                <span class="drag">⠿</span
                ><strong>{{ group.name || `未命名策略组 ${index + 1}` }}</strong
                ><small>{{ groupTypes.find((item) => item.value === group.type)?.label || group.type }}</small
                ><span class="chevron" />
              </button>
              <div class="group-actions">
                <el-button
                  circle
                  size="small"
                  :disabled="index === 0"
                  @click="moveGroup(index, -1)"
                  >↑</el-button
                ><el-button
                  circle
                  size="small"
                  :disabled="index === groups.length - 1"
                  @click="moveGroup(index, 1)"
                  >↓</el-button
                ><el-button
                  circle
                  size="small"
                  type="danger"
                  plain
                  @click="groups.splice(index, 1)"
                  >×</el-button
                >
              </div>
            </div>
            <div v-if="expandedGroups.includes(index)" class="fields">
              <div class="field-grid">
                <label>策略组名称<el-input v-model="group.name" /></label>
                <label>组类型<el-select v-model="group.type"><el-option v-for="item in groupTypes" :key="item.value" :label="item.label" :value="item.value" /></el-select></label>
              </div>
              <div class="members">
                <label>策略组成员</label>
                <div v-for="(_, memberIndex) in group.policies" :key="memberIndex" class="member"><el-input v-model="group.policies[memberIndex]" placeholder="节点、策略组、DIRECT 或 REJECT" /><el-button link type="danger" @click="group.policies.splice(memberIndex, 1)">移除</el-button></div>
                <el-button size="small" plain @click="group.policies.push('')">添加成员</el-button>
              </div>
              <div v-if="group.type !== 'select'" class="field-grid">
                <label>测速 URL<el-input v-model="group.url" placeholder="http://www.gstatic.com/generate_204" /></label>
                <label>测速间隔（秒）<el-input v-model="group.interval" placeholder="600" /></label>
                <label v-if="group.type === 'url-test'">容差（毫秒）<el-input v-model="group.tolerance" placeholder="50" /></label>
                <label v-if="group.type === 'fallback' || group.type === 'load-balance'">超时（毫秒）<el-input v-model="group.maxTimeout" placeholder="5000" /></label>
                <label v-if="group.type === 'load-balance'">负载算法<el-select v-model="group.algorithm" clearable><el-option label="Random" value="Random" /><el-option label="PCC" value="PCC" /><el-option label="Round-Robin" value="Round-Robin" /></el-select></label>
              </div>
              <div class="rule-toggle">
                <button @click="toggleRuleList(index)">
                  流量规则（{{ groupRules(group.name).length }}）<small>{{
                    expandedRules.includes(index) ? "收起" : "展开"
                  }}</small>
                </button>
              </div>
              <div v-if="expandedRules.includes(index)" class="rule-list">
                <el-button size="small" plain @click="addRule(group.name)"
                  >添加规则</el-button
                >
                <div v-if="!groupRules(group.name).length" class="empty">
                  暂无引用此策略组的规则
                </div>
                <div
                  v-for="entry in groupRules(group.name)"
                  :key="entry.index"
                  class="rule"
                >
                  <el-input
                    :model-value="entry.rule.value"
                    @update:model-value="updateRule(entry.rule, String($event))"
                  /><el-button
                    link
                    type="danger"
                    @click="rules.splice(entry.index, 1)"
                    >删除</el-button
                  >
                </div>
              </div>
            </div>
          </div>
          <el-empty
            v-if="!groups.length"
            description="暂无策略组"
            :image-size="58"
          />
        </section>
        <section
          v-for="section in sections.filter(
            (item) => !['proxy group', 'rule'].includes(item.name.toLowerCase())
          )"
          :key="section.name"
          class="card raw"
        >
          <div class="card-head">
            <button @click="toggleSection(section.name)">
              <strong>[{{ section.name }}]</strong
              ><span class="chevron" /></button
            ><el-button
              link
              type="danger"
              @click="sections.splice(sections.indexOf(section), 1)"
              >删除分段</el-button
            >
          </div>
          <div v-if="expandedSections.includes(section.name)" class="fields">
            <div
              v-for="(_, lineIndex) in section.lines"
              :key="lineIndex"
              class="rule"
            >
              <el-input v-model="section.lines[lineIndex]" /><el-button
                link
                type="danger"
                @click="section.lines.splice(lineIndex, 1)"
                >删除</el-button
              >
            </div>
            <el-button link type="primary" @click="section.lines.push('')"
              >添加一行</el-button
            >
          </div>
        </section>
      </div></el-scrollbar
    >
  </section>
</template>
<style scoped>
.loon-editor {
  display: flex;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
}
.loon-editor header,
.card-head,
.card-head button,
.rule,
.group-actions {
  display: flex;
  align-items: center;
}
.loon-editor header,
.card-head {
  justify-content: space-between;
  padding: 14px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.loon-editor header {
  min-height: 52px;
  padding: 0 18px;
}
.loon-editor header em {
  display: inline-flex;
  min-width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  margin-left: 5px;
  border-radius: 10px;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  font-size: 12px;
  font-style: normal;
}
small {
  display: block;
  margin-top: 4px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.body {
  min-height: 0;
  flex: 1;
}
.content {
  display: grid;
  gap: 12px;
  padding: 14px;
}
.proxy-groups {
  display: grid;
  gap: 12px;
}
.card {
  overflow: hidden;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
}
.card.expanded {
  border-color: var(--el-color-primary-light-5);
  box-shadow: 0 5px 16px rgb(0 0 0 / 4%);
}
.card-head {
  min-height: 54px;
  padding: 0 11px;
  background: var(--el-fill-color-light);
}
.card-head button,
.rule-toggle button {
  min-width: 0;
  flex: 1;
  justify-content: flex-start;
  gap: 9px;
  padding: 0;
  border: 0;
  color: var(--el-text-color-primary);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.card-head button strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
}
.card-head button small {
  margin: 0 0 0 auto;
  padding: 4px 7px;
  border-radius: 2px;
  background: var(--el-fill-color);
}
.drag {
  color: var(--el-text-color-secondary);
  font-size: 18px;
  letter-spacing: -3px;
}
.chevron {
  width: 8px;
  height: 8px;
  flex: none;
  margin: 0 7px 4px 4px;
  border-right: 2px solid var(--el-text-color-secondary);
  border-bottom: 2px solid var(--el-text-color-secondary);
  transform: rotate(45deg);
}
.expanded .chevron {
  margin-top: 5px;
  margin-bottom: 0;
  transform: rotate(225deg);
}
.group-actions {
  gap: 8px;
}
.group-actions :deep(.el-button) {
  width: 25px;
  height: 25px;
  margin: 0;
  border-color: var(--el-border-color);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
}
.group-actions :deep(.el-button--danger) {
  border-color: var(--el-color-danger-light-5);
  color: var(--el-color-danger);
}
.fields {
  display: grid;
  gap: 12px;
  padding: 14px;
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.field-grid :deep(.el-select) { width: 100%; }
.members { display: grid; gap: 8px; }
.member { display: flex; align-items: center; gap: 8px; }
.member :deep(.el-input) { flex: 1; }
label {
  display: grid;
  gap: 6px;
  font-size: 13px;
  font-weight: 650;
}
.rule-toggle {
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 6px;
}
.rule-toggle button {
  min-height: 34px;
  font-weight: 700;
}
.rule-toggle small {
  margin: 0;
  color: var(--el-color-primary);
  font-weight: 500;
}
.rule-list {
  display: grid;
  gap: 8px;
}
.empty {
  padding: 8px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.rule {
  gap: 8px;
}
.rule .el-input {
  flex: 1;
}
.raw .card-head {
  border-bottom: 0;
}
.raw .fields {
  border-top: 1px solid var(--el-border-color-lighter);
}
@media (max-width: 700px) {
  .drag,
  .card-head button small {
    display: none;
  }
  .group-actions {
    gap: 4px;
  }
  .field-grid { grid-template-columns: 1fr; }
  .member { align-items: stretch; flex-direction: column; }
  .member :deep(.el-button) { align-self: flex-end; }
  .rule {
    align-items: stretch;
    flex-direction: column;
  }
  .rule .el-button {
    align-self: flex-end;
  }
}
</style>
