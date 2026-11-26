import type { ReactElement } from "react";
import * as Primitive from "@radix-ui/react-dialog";
import { Dialog, DialogPortal } from "@/components/ui/dialog";

/** Retain the custom panel layout, but share the same dismissal/focus stack as nested dialogs and selects. */
export function SubscriptionDialogFrame({ title, onClose, children }: { title: string; onClose: () => void; children: ReactElement }) {
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogPortal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-slate-950/55 dark:bg-black/70" />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center overflow-y-auto p-3">
          <Primitive.Content asChild aria-label={title} aria-describedby={undefined} className="pointer-events-auto">
            {children}
          </Primitive.Content>
        </div>
      </DialogPortal>
    </Dialog>
  );
}
