export type CodeSearchSelectionTarget = {
  clientHeight: number;
  setSelectionRange: (start: number, end: number) => void;
  scrollTo: (options: ScrollToOptions) => void;
};

/**
 * Select and reveal a search match without focusing the editor.
 * The search input owns focus while the user types; focusing the editor here
 * would steal it on every controlled-input update.
 */
export function applyCodeSearchSelection(
  target: CodeSearchSelectionTarget,
  index: number,
  queryLength: number,
  line: number,
) {
  target.setSelectionRange(index, index + queryLength);
  target.scrollTo({
    top: Math.max(0, line * 28 - target.clientHeight / 3),
    behavior: "smooth",
  });
}
