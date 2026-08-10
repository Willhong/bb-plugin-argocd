import { cn } from "@/lib/utils";

// Intentionally local, matching the GitHub plugin: a full-region centered zero
// state, unlike the host's inline hint or dashed-border empty-state variants.
export function EmptyState({
  message,
  className,
}: {
  message: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1 px-6 py-12 text-center",
        className,
      )}
    >
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
