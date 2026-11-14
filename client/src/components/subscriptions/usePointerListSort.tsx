import { createPortal } from "react-dom";
import { useCallback, useState, type PointerEvent, type ReactNode } from "react";

type DragState = { index: number; x: number; y: number; offsetX: number; offsetY: number } | null;

/** Pointer-driven list sorting with a card overlay, matching the subscription wizard. */
export function usePointerListSort(onMove: (from: number, to: number) => void, renderOverlay: (index: number) => ReactNode) {
  const [drag, setDrag] = useState<DragState>(null);
  const begin = useCallback((index: number, event: PointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const item = event.currentTarget.closest<HTMLElement>("[data-pointer-sort-index]");
    const rect = item?.getBoundingClientRect();
    setDrag({ index, x: event.clientX, y: event.clientY, offsetX: rect ? event.clientX - rect.left : 24, offsetY: rect ? event.clientY - rect.top : 24 });
  }, []);
  const move = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!drag) return;
    setDrag((current) => current ? { ...current, x: event.clientX, y: event.clientY } : null);
  }, [drag]);
  const end = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-pointer-sort-index]");
    const index = Number(target?.dataset.pointerSortIndex);
    if (Number.isInteger(index) && index >= 0 && index !== drag.index) onMove(drag.index, index);
    setDrag(null);
  }, [drag, onMove]);
  const overlay = drag && typeof document !== "undefined" ? createPortal(<div className="pointer-events-none fixed z-[100]" style={{ left: drag.x - drag.offsetX, top: drag.y - drag.offsetY }}>{renderOverlay(drag.index)}</div>, document.body) : null;
  return { begin, move, end, overlay, draggingIndex: drag?.index ?? null };
}
