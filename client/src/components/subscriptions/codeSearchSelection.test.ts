import assert from "node:assert/strict";
import test from "node:test";
import { applyCodeSearchSelection } from "./codeSearchSelection";

test("search match selection does not steal focus from the YAML search input", () => {
  let focused = false;
  let selection: [number, number] | undefined;
  let scroll: ScrollToOptions | undefined;
  const editor = {
    clientHeight: 300,
    setSelectionRange: (start: number, end: number) => { selection = [start, end]; },
    scrollTo: (options: ScrollToOptions) => { scroll = options; },
    focus: () => { focused = true; },
  };

  applyCodeSearchSelection(editor, 12, 3, 4);

  assert.deepEqual(selection, [12, 15]);
  assert.deepEqual(scroll, { top: 12 * 28 - 100, behavior: "smooth" });
  assert.equal(focused, false);
});
