"use client";

import { useTransition, useState } from "react";
import { toggleAdStatusAction } from "./actions";

export function AdStatusToggle({
  adId,
  isActive,
}: {
  adId: string;
  isActive: boolean;
}) {
  const [optimistic, setOptimistic] = useState(isActive);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !optimistic;
    setOptimistic(next);
    startTransition(async () => {
      const result = await toggleAdStatusAction(adId, next ? "ACTIVE" : "PAUSED");
      if (!result.ok) setOptimistic(!next);
    });
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={toggle}
      title={optimistic ? "Pause ad" : "Resume ad"}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-50 ${
        optimistic ? "bg-blue-600" : "bg-zinc-300 dark:bg-zinc-600"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
          optimistic ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}
