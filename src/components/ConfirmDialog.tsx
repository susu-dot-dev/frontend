import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";

type Props = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** Shown inside the dialog when the action failed, so the reason stays next to the retry. */
  error?: string | null;
  /** True while the action is running: the dialog can't be dismissed and can't be confirmed twice. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** A modal that asks before a destructive action. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  error = null,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {error !== null && (
          <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
