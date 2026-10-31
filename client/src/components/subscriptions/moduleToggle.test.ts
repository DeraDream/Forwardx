import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parse } from "yaml";
import { moduleRanges, toggleModuleComment, uncommentModuleEntries } from "./moduleToggle";

test("Loon plugin toggles comment without changing other lines or URL query", () => {
  const source = "[Plugin]\nhttps://a.example/p?x=1,tag=A,proxy=DIRECT,enable=true\nhttps://b.example/p,tag=B\n[Rule]\nFINAL,DIRECT\n";
  const off = toggleModuleComment("loon", source, 0, false);
  assert.equal(off.line, 2);
  assert.match(off.source, /# https:\/\/a\.example\/p\?x=1,tag=A,proxy=DIRECT,enable=true/);
  assert.equal(toggleModuleComment("loon", off.source, 0, true).source, source);
  assert.equal(moduleRanges("loon", off.source).length, 2);
});

test("Egern toggle preserves nested module data and original comments", () => {
  const source = "policy_groups: []\nmodules:\n  - name: A\n    url: https://a.example/m\n    env:\n      KEY: value\n    # original\n  - url: https://b.example/m\nrules: []\n";
  const off = toggleModuleComment("egern", source, 0, false);
  assert.equal(off.line, 3);
  assert.match(off.source, /  # - name: A/);
  assert.equal(moduleRanges("egern", off.source).length, 2);
  assert.equal(parse(uncommentModuleEntries("egern", off.source)).modules[0].env.KEY, "value");
  assert.equal(toggleModuleComment("egern", off.source, 0, true).source, source);
});

test("enabling existing native disabled flag removes the effective disable", () => {
  const loon = "[Plugin]\nhttps://a.example/p,enable=false\n";
  assert.match(toggleModuleComment("loon", loon, 0, true).source, /enable=true/);
  const egern = "modules:\n  - url: https://a.example/m\n    enabled: false\n";
  assert.match(toggleModuleComment("egern", egern, 0, true).source, /enabled: true/);
});
