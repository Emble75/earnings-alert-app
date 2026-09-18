"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { performAction, type ActionKind } from "@/app/actions";

/**
 * A button that triggers one server action.
 *
 * It takes a kind and an id - never a function - so nothing unserialisable
 * crosses the server/client boundary. Backend refusals are shown verbatim:
 * "the capital limit would be exceeded" is information the operator needs,
 * not an error to hide.
 */
export function ActionButton({
  kind,
  id,
  label,
  pendingLabel,
  variant = "secondary",
  confirm,
}: {
  kind: ActionKind;
  id: number;
  label: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "danger";
  confirm?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const classes =
    variant === "primary"
      ? "bg-accent text-white hover:opacity-90"
      : variant === "danger"
        ? "border border-negative/40 text-negative hover:bg-negative/10"
        : "border border-border hover:bg-surface";

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={pending}
        className={`inline-flex items-center rounded px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${classes}`}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          setError(null);
          startTransition(async () => {
            const result = await performAction(kind, id);
            if (result.ok) {
              router.refresh();
            } else {
              setError(result.message ?? "the action failed");
            }
          });
        }}
      >
        {pending ? (pendingLabel ?? "Working...") : label}
      </button>
      {error && <p className="max-w-sm text-xs text-negative">{error}</p>}
    </div>
  );
}
