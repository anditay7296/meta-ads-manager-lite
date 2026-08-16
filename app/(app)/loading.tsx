export default function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="flex items-center gap-3 text-sm text-zinc-500">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-600" />
        Loading…
      </div>
    </div>
  );
}
