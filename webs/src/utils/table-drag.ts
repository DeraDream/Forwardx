import type Sortable from "sortablejs";
import type { Ref } from "vue";
import { nextTick, onBeforeUnmount, onMounted, watch } from "vue";

interface DraggableTableOptions<T> {
  tableRef: Ref<any>;
  rows: Ref<T[]>;
  enabled?: Ref<boolean>;
  startIndex?: () => number;
  storageKey?: string | (() => string);
  rowKey?: (row: T) => string | number | undefined;
}

export function useDraggableTableRows<T>({
  tableRef,
  rows,
  enabled,
  startIndex = () => 0,
  storageKey,
  rowKey,
}: DraggableTableOptions<T>) {
  let sortable: Sortable | undefined;
  let tbody: HTMLElement | undefined;
  let applyingStoredOrder = false;

  const getRowKey = (row: T) => rowKey?.(row);
  const getStorageKey = () =>
    typeof storageKey === "function" ? storageKey() : storageKey;

  const readStoredOrder = () => {
    const key = getStorageKey();
    if (!key) return [];
    try {
      const value = localStorage.getItem(key);
      return value ? (JSON.parse(value) as Array<string | number>) : [];
    } catch {
      return [];
    }
  };

  const persistOrder = () => {
    const key = getStorageKey();
    if (!key || !rowKey) return;
    const order = rows.value
      .map((row) => getRowKey(row))
      .filter((key): key is string | number => key !== undefined);
    localStorage.setItem(key, JSON.stringify(order));
  };

  const applyStoredOrder = () => {
    if (!getStorageKey() || !rowKey || applyingStoredOrder) return;
    const order = readStoredOrder();
    if (!order.length) return;
    const position = new Map(order.map((key, index) => [String(key), index]));
    const sortedRows = [...rows.value].sort((left, right) => {
      const leftIndex =
        position.get(String(getRowKey(left))) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex =
        position.get(String(getRowKey(right))) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    });
    const alreadySorted = rows.value.every(
      (row, index) => getRowKey(row) === getRowKey(sortedRows[index])
    );
    if (alreadySorted) return;
    applyingStoredOrder = true;
    rows.value = sortedRows;
    applyingStoredOrder = false;
  };

  const destroy = () => {
    sortable?.destroy();
    sortable = undefined;
    tbody = undefined;
  };

  const bind = async () => {
    if (enabled && !enabled.value) {
      destroy();
      return;
    }
    await nextTick();
    if (enabled && !enabled.value) return;
    const root = tableRef.value?.$el || tableRef.value;
    const nextTbody = root?.querySelector?.(".el-table__body-wrapper tbody") as
      | HTMLElement
      | undefined;
    if (!nextTbody || nextTbody === tbody) return;

    const { default: Sortable } = await import("sortablejs");
    if (enabled && !enabled.value) return;
    destroy();
    tbody = nextTbody;
    sortable = Sortable.create(nextTbody, {
      animation: 150,
      draggable: "tr",
      handle: ".row-drag-handle",
      ghostClass: "table-row-ghost",
      onEnd: ({ oldIndex, newIndex }) => {
        if (
          oldIndex === undefined ||
          newIndex === undefined ||
          oldIndex === newIndex
        ) {
          return;
        }
        const from = startIndex() + oldIndex;
        const to = startIndex() + newIndex;
        const nextRows = [...rows.value];
        const moved = nextRows.splice(from, 1)[0];
        if (!moved) return;
        nextRows.splice(to, 0, moved);
        rows.value = nextRows;
        persistOrder();
      },
    });
  };

  onMounted(() => {
    if (!enabled || enabled.value) {
      bind();
    }
  });
  watch(
    () => [
      enabled?.value ?? true,
      rows.value.length,
      rows.value.map((row) => getRowKey(row)).join("|"),
      startIndex(),
      getStorageKey(),
    ],
    () => {
      applyStoredOrder();
      if (enabled && !enabled.value) {
        destroy();
        return;
      }
      bind();
    },
    { flush: "post" }
  );
  onBeforeUnmount(destroy);
}
