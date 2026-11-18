import { Button } from "@/components/ui/button";

/**
 * A read-only, select-on-focus text area with a Copy button, for a secret that is
 * shown once. The caller owns the `copied` state so it can reset when remounted.
 */
export function CopyField({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Button type="button" variant="outline" size="sm" onClick={onCopy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <textarea
        readOnly
        aria-label={label}
        value={value}
        rows={2}
        onFocus={(event) => event.currentTarget.select()}
        className="block w-full resize-none rounded-md border bg-muted p-3 font-mono text-sm break-all"
      />
    </div>
  );
}
