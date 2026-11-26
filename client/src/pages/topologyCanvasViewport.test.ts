import assert from "node:assert/strict";
import test from "node:test";
import { clampTopologyZoom, fitTopologyZoom, topologyCanvasOverflow } from "./topologyCanvasViewport";

test("topology zoom controls permit enlargement and keep a bounded fit", () => {
  assert.equal(clampTopologyZoom(1 + 0.1), 1.1);
  assert.equal(clampTopologyZoom(2), 1.5);
  assert.equal(clampTopologyZoom(0), 0.2);
  assert.equal(fitTopologyZoom(500, 600, 2000, 800, false), 0.25);
  assert.equal(fitTopologyZoom(500, 600, 2000, 800, true), 0.65);
});

test("only an activated canvas owns wheel scrolling", () => {
  assert.equal(topologyCanvasOverflow(false), "overflow-hidden");
  assert.equal(topologyCanvasOverflow(true), "overflow-auto overscroll-contain");
});
