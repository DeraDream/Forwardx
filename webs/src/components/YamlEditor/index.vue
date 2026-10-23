<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import {
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import { Compartment, EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    language?: "yaml" | "ini";
  }>(),
  { language: "yaml" }
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const editorElement = ref<HTMLElement>();
let editorView: EditorView | undefined;
let removeWheelGuard: (() => void) | undefined;
const languageCompartment = new Compartment();

const installWheelGuard = (view: EditorView) => {
  const scroller = view.scrollDOM;
  const handleWheel = (event: WheelEvent) => {
    const atTop = scroller.scrollTop <= 0;
    const atBottom =
      Math.ceil(scroller.scrollTop + scroller.clientHeight) >=
      scroller.scrollHeight;

    if (
      (event.deltaY < 0 && atTop) ||
      (event.deltaY > 0 && atBottom)
    ) {
      event.preventDefault();
    }
    event.stopPropagation();
  };

  scroller.addEventListener("wheel", handleWheel, { passive: false });
  return () => scroller.removeEventListener("wheel", handleWheel);
};

const explicitSelectionHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView) {
      return Decoration.set(
        view.state.selection.ranges
          .filter((range) => !range.empty)
          .map((range) =>
            Decoration.mark({ class: "cm-explicit-selection" }).range(
              range.from,
              range.to
            )
          ),
        true
      );
    }
  },
  {
    decorations: (value) => value.decorations,
  }
);

const indentationGuides = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView) {
      const ranges: Range<Decoration>[] = [];

      for (const { from, to } of view.visibleRanges) {
        let line = view.state.doc.lineAt(from);
        while (line.from <= to) {
          const spaces = line.text.match(/^ +/)?.[0].length ?? 0;
          for (let offset = 0; offset < spaces; offset += 2) {
            ranges.push(
              Decoration.mark({ class: "cm-indent-guide" }).range(
                line.from + offset,
                line.from + offset + 1
              )
            );
          }
          if (line.to >= to || line.number === view.state.doc.lines) break;
          line = view.state.doc.line(line.number + 1);
        }
      }

      return Decoration.set(ranges, true);
    }
  },
  {
    decorations: (value) => value.decorations,
  }
);

const iniHighlighting = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView) {
      const ranges: Range<Decoration>[] = [];
      const mark = (className: string, from: number, to: number) => {
        if (to > from) ranges.push(Decoration.mark({ class: className }).range(from, to));
      };
      for (const { from, to } of view.visibleRanges) {
        let line = view.state.doc.lineAt(from);
        while (line.from <= to) {
          const text = line.text;
          const leading = text.search(/\S/);
          if (leading >= 0) {
            const trimmed = text.slice(leading);
            if (/^\[[^\]]+\]/.test(trimmed)) mark("cm-ini-section", line.from + leading, line.to);
            else if (/^[#;]/.test(trimmed)) mark("cm-ini-comment", line.from + leading, line.to);
            else {
              const equals = text.indexOf("=");
              if (equals >= 0) {
                mark("cm-ini-key", line.from + leading, line.from + equals);
                mark("cm-ini-operator", line.from + equals, line.from + equals + 1);
                const values = text.slice(equals + 1);
                const matcher = /https?:\/\/[^,\s]+|__[A-Z0-9_]+__|\$\{[^}]+\}|\{\{[^}]+\}\}|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:DIRECT|REJECT|REJECT-DROP|PROXY|URL-REJECT|COMPATIBLE)\b|\b(?:true|false|yes|no|on|off)\b|(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?|[-+]?\d+(?:\.\d+)?\b|[^,\s]+/gi;
                for (const token of values.matchAll(matcher)) {
                  const value = token[0], tokenFrom = line.from + equals + 1 + (token.index || 0);
                  const className = /^https?:/i.test(value)
                    ? "cm-ini-url"
                    : /^__|^\$\{|^\{\{/.test(value)
                      ? "cm-ini-variable"
                      : /^(DIRECT|REJECT|REJECT-DROP|PROXY|URL-REJECT|COMPATIBLE)$/i.test(value)
                        ? "cm-ini-directive"
                        : /^(true|false|yes|no|on|off)$/i.test(value) || /^[-+]?\d/.test(value)
                          ? "cm-ini-literal"
                          : /^["']/.test(value)
                            ? "cm-ini-quoted"
                            : "cm-ini-string";
                  mark(className, tokenFrom, tokenFrom + value.length);
                }
              }
            }
          }
          if (line.to >= to || line.number === view.state.doc.lines) break;
          line = view.state.doc.line(line.number + 1);
        }
      }
      return Decoration.set(ranges, true);
    }
  },
  { decorations: (value) => value.decorations }
);

const languageExtension = (language: "yaml" | "ini"): Extension =>
  language === "ini" ? iniHighlighting : yaml();

const chinesePhrases = EditorState.phrases.of({
  Find: "查找",
  Replace: "替换为",
  next: "下一个",
  previous: "上一个",
  all: "全部",
  "match case": "区分大小写",
  regexp: "正则表达式",
  "by word": "全字匹配",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "current match": "当前匹配",
  "replaced $ matches": "已替换 $ 处",
});

onMounted(() => {
  editorView = new EditorView({
    parent: editorElement.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        languageCompartment.of(languageExtension(props.language)),
        search({
          top: true,
        }),
        highlightSelectionMatches({
          wholeWords: false,
        }),
        explicitSelectionHighlight,
        indentationGuides,
        chinesePhrases,
        syntaxHighlighting(
          HighlightStyle.define([
            {
              tag: [tags.propertyName, tags.typeName, tags.labelName],
              color: "var(--editor-key)",
              fontWeight: "600",
            },
            {
              tag: [tags.string, tags.special(tags.string), tags.content],
              color: "var(--editor-string)",
            },
            {
              tag: [tags.number, tags.bool, tags.null],
              color: "var(--editor-number)",
            },
            {
              tag: [tags.atom, tags.literal],
              color: "var(--editor-literal)",
            },
            { tag: tags.url, color: "var(--editor-url)", textDecoration: "underline" },
            { tag: tags.heading, color: "var(--editor-section)", fontWeight: "600" },
            { tag: [tags.meta, tags.special(tags.variableName)], color: "var(--editor-variable)" },
            {
              tag: [tags.keyword, tags.operator, tags.punctuation, tags.separator],
              color: "var(--editor-operator)",
            },
            {
              tag: tags.variableName,
              color: "var(--editor-variable)",
            },
            {
              tag: tags.comment,
              color: "var(--editor-comment)",
              fontStyle: "italic",
            },
          ])
        ),
        EditorState.tabSize.of(2),
        keymap.of([indentWithTab, ...searchKeymap]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            emit("update:modelValue", update.state.doc.toString());
          }
        }),
        EditorView.theme({
          "&": {
            height: "100%",
            color: "var(--el-text-color-primary)",
            backgroundColor: "var(--el-bg-color)",
            fontSize: "13px",
          },
          ".cm-scroller": {
            overflow: "auto",
            minHeight: "0",
            overscrollBehavior: "contain",
            scrollbarGutter: "stable",
            fontFamily:
              '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
          },
          ".cm-content": {
            minHeight: "100%",
            boxSizing: "border-box",
            padding: "14px 0 22px",
            caretColor: "var(--editor-cursor)",
          },
          ".cm-cursor": {
            borderLeftColor: "var(--editor-cursor)",
          },
          ".cm-line": {
            padding: "0 16px",
          },
          ".cm-gutters": {
            color: "var(--el-text-color-placeholder)",
            backgroundColor: "var(--el-fill-color-light)",
            borderRight: "1px solid var(--el-border-color-lighter)",
          },
          ".cm-activeLine, .cm-activeLineGutter": {
            backgroundColor: "var(--editor-active-line)",
          },
          "&.cm-focused": {
            outline: "none",
          },
          ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
            backgroundColor:
              "color-mix(in srgb, var(--el-color-primary) 38%, transparent) !important",
          },
          ".cm-content ::selection": {
            color: "inherit",
            backgroundColor:
              "color-mix(in srgb, var(--el-color-primary) 38%, transparent) !important",
          },
          ".cm-explicit-selection": {
            backgroundColor:
              "color-mix(in srgb, var(--el-color-primary) 38%, transparent)",
            borderRadius: "2px",
          },
          ".cm-selectionMatch": {
            backgroundColor:
              "color-mix(in srgb, var(--el-color-warning) 28%, transparent)",
            outline:
              "1px solid color-mix(in srgb, var(--el-color-warning) 65%, transparent)",
          },
          ".cm-searchMatch": {
            backgroundColor:
              "color-mix(in srgb, var(--el-color-warning) 34%, transparent)",
            outline:
              "1px solid color-mix(in srgb, var(--el-color-warning) 70%, transparent)",
          },
          ".cm-searchMatch.cm-searchMatch-selected": {
            backgroundColor:
              "color-mix(in srgb, var(--el-color-primary) 38%, transparent)",
            outline: "1px solid var(--el-color-primary)",
          },
          ".cm-indent-guide": {
            borderLeft:
              "1px solid color-mix(in srgb, var(--el-text-color-placeholder) 30%, transparent)",
          },
          ".cm-ini-key": { color: "var(--editor-key)" },
          ".cm-ini-string": { color: "var(--editor-string)" },
          ".cm-ini-quoted": { color: "var(--editor-quoted)" },
          ".cm-ini-literal": { color: "var(--editor-literal)" },
          ".cm-ini-url": { color: "var(--editor-url)" },
          ".cm-ini-variable": { color: "var(--editor-variable)" },
          ".cm-ini-directive": { color: "var(--editor-directive)" },
          ".cm-ini-section": { color: "var(--editor-section)" },
          ".cm-ini-comment": { color: "var(--editor-comment)" },
          ".cm-ini-operator": { color: "var(--editor-operator)" },
          ".cm-panels": {
            color: "var(--el-text-color-primary)",
            backgroundColor: "var(--el-fill-color-light)",
          },
          ".cm-panels.cm-panels-top": {
            borderBottom: "1px solid var(--el-border-color)",
          },
          ".cm-search": {
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "6px",
            padding: "10px 38px 10px 12px",
          },
          ".cm-search input": {
            height: "30px",
            boxSizing: "border-box",
            border: "1px solid var(--el-border-color)",
            borderRadius: "4px",
            padding: "0 9px",
            color: "var(--el-text-color-primary)",
            backgroundColor: "var(--el-bg-color)",
            fontFamily: "inherit",
          },
          ".cm-search input:focus": {
            borderColor: "var(--el-color-primary)",
            outline: "none",
          },
          ".cm-search button": {
            height: "30px",
            border: "1px solid var(--el-border-color)",
            borderRadius: "4px",
            padding: "0 10px",
            color: "var(--el-text-color-regular)",
            backgroundColor: "var(--el-bg-color)",
            cursor: "pointer",
          },
          ".cm-search button:hover": {
            color: "var(--el-color-primary)",
            borderColor: "var(--el-color-primary)",
          },
          ".cm-search label": {
            display: "inline-flex",
            alignItems: "center",
            gap: "3px",
            whiteSpace: "nowrap",
          },
          ".cm-search .cm-button[name=close]": {
            position: "absolute",
            top: "9px",
            right: "10px",
          },
        }),
      ],
    }),
  });
  removeWheelGuard = installWheelGuard(editorView);
});

const showSearchPanel = () => {
  if (editorView) {
    openSearchPanel(editorView);
    editorView.focus();
  }
};

defineExpose({ showSearchPanel });

watch(
  () => props.modelValue,
  (value) => {
    if (!editorView || value === editorView.state.doc.toString()) {
      return;
    }

    editorView.dispatch({
      changes: {
        from: 0,
        to: editorView.state.doc.length,
        insert: value,
      },
    });
  }
);

onBeforeUnmount(() => {
  removeWheelGuard?.();
  editorView?.destroy();
});

watch(
  () => props.language,
  (language) =>
    editorView?.dispatch({
      effects: languageCompartment.reconfigure(languageExtension(language)),
    })
);
</script>

<template>
  <div ref="editorElement" class="yaml-editor" />
</template>

<style scoped>
.yaml-editor {
  height: 100%;
  min-height: 0;
}
</style>
