// Shown while a Settings tab's code loads. In a file of its own so the Settings
// dialog's shell doesn't pull the tabs' building blocks (settings/parts) into the main chunk.
export function TabSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-6" role="status" aria-label="Loading">
      <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      <div className="h-3 w-72 animate-pulse rounded bg-muted" />
      <div className="h-24 max-w-2xl animate-pulse rounded-lg bg-muted" />
    </div>
  );
}
