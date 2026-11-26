export function clampTopologyZoom(zoom: number) {
  return Number.isFinite(zoom) ? Math.min(1.5, Math.max(0.2, Math.round(zoom * 100) / 100)) : 1;
}

export function fitTopologyZoom(canvasWidth: number, canvasHeight: number, graphWidth: number, graphHeight: number, mobile: boolean) {
  if (canvasWidth <= 0 || canvasHeight <= 0 || graphWidth <= 0 || graphHeight <= 0) return 1;
  return clampTopologyZoom(mobile
    ? Math.min(1, Math.max(0.65, canvasWidth / graphWidth))
    : Math.min(1, canvasWidth / graphWidth, canvasHeight / graphHeight));
}

export function topologyCanvasOverflow(activated: boolean) {
  // A hidden-overflow viewport does not take the document's wheel scroll.
  return activated ? "overflow-auto overscroll-contain" : "overflow-hidden";
}
