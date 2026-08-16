"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { CreateRuleDialog } from "./CreateRuleDialog";

export function NewRuleButton({
  activeProjectName,
}: {
  activeProjectName: string | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
      >
        <Plus className="h-3.5 w-3.5" />
        New Rule
      </button>
      <CreateRuleDialog
        open={open}
        onClose={() => setOpen(false)}
        activeProjectName={activeProjectName}
      />
    </>
  );
}
