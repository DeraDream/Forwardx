import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseTopologyAnnotations, topologyAnnotationsSchema } from "./topologyAnnotations";

const item = { id: "b0f1c121-9a69-48f5-b640-a5a4b2e2f6e1", name: "专线 A", address: "", target: "QHIX", note: "手动配置" };

test("manual annotations round-trip and trim text", () => {
  assert.deepEqual(parseTopologyAnnotations(null), []);
  assert.deepEqual(parseTopologyAnnotations(JSON.stringify([item])), [item]);
  assert.equal(topologyAnnotationsSchema.parse([{ ...item, name: "  A  " }])[0].name, "A");
});

test("rejects malformed, duplicate or oversized annotations", () => {
  assert.throws(() => parseTopologyAnnotations("not json"));
  assert.throws(() => topologyAnnotationsSchema.parse([item, item]));
  assert.throws(() => topologyAnnotationsSchema.parse([{ ...item, target: "" }]));
  assert.throws(() => topologyAnnotationsSchema.parse(Array.from({ length: 51 }, () => item)));
});
