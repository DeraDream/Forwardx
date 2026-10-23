function isTextEditingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tagName = element.tagName?.toLowerCase();
  if (tagName === "textarea") return true;
  if (element.isContentEditable) return true;
  return Boolean(element.closest(".cm-editor, .w-e-text-container"));
}

function topmostDialog() {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>(".el-overlay-dialog .el-dialog")
  ).filter((dialog) => dialog.offsetParent !== null);
  return dialogs.at(-1);
}

export function setupDialogKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    const dialog = topmostDialog();
    if (!dialog) return;

    if (event.key === "Escape") {
      const closeButton = dialog.querySelector<HTMLButtonElement>(
        ".el-dialog__headerbtn"
      );
      closeButton?.click();
      return;
    }

    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }
    if (isTextEditingTarget(event.target)) return;

    const primaryButton = dialog.querySelector<HTMLButtonElement>(
      ".el-dialog__footer .el-button--primary:not([disabled])"
    );
    if (!primaryButton) return;

    event.preventDefault();
    primaryButton.click();
  });
}
