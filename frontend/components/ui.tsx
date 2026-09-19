/** Shared presentation primitives. */

import Link from "next/link";
import type { ReactNode } from "react";

import { isNegative, money, titleCase } from "@/lib/format";

export function Card({
  title, subtitle, children, actions, className = "",
}: {
  title?: string; subtitle?: string; children: ReactNode; actions?: ReactNode; className?: string;
}) {
  return (
    <section className={`rounded-lg border border-border bg-surface-raised ${className}`}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const TONES = {
  positive: "bg-positive/10 text-positive border-positive/30",
  caution: "bg-caution/10 text-caution border-caution/30",
  negative: "bg-negative/10 text-negative border-negative/30",
  accent: "bg-accent/10 text-accent border-accent/30",
  muted: "bg-ink-muted/10 text-ink-muted border-ink-muted/30",
} as const;

export type Tone = keyof typeof TONES;

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

/** Maps a workflow state to a tone, so colour means the same thing everywhere. */
export function stateTone(state: string): Tone {
  if (["ACTIONABLE", "COMPLETED", "DELIVERED", "APPROVED", "PUBLISHED", "LISTED"].includes(state)) {
    return "positive";
  }
  if (["BLOCKED", "FAILED", "REJECTED", "CANCELLED", "EXPIRED", "LOST"].includes(state)) {
    return "negative";
  }
  if (["APPROVAL_REQUIRED", "REVALIDATION_REQUIRED", "RISK_REVIEW", "RETURN_REQUESTED", "EXCEPTION"].includes(state)) {
    return "caution";
  }
  return "accent";
}

export function StateBadge({ state }: { state: string }) {
  return <Badge tone={stateTone(state)}>{titleCase(state)}</Badge>;
}

export function Stat({
  label, value, hint, tone,
}: {
  label: string; value: ReactNode; hint?: string; tone?: Tone;
}) {
  const colour =
    tone === "positive" ? "text-positive"
    : tone === "negative" ? "text-negative"
    : tone === "caution" ? "text-caution"
    : "text-ink";
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-4">
      <p className="text-xs uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`numeric mt-1 text-2xl font-semibold ${colour}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

export function Money({ value, currency = "EUR", signed = false }: {
  value: string | null; currency?: string; signed?: boolean;
}) {
  const negative = isNegative(value);
  const colour = !signed ? "" : negative ? "text-negative" : "text-positive";
  const prefix = signed && !negative && value ? "+" : "";
  return <span className={`numeric ${colour}`}>{prefix}{money(value, currency)}</span>;
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
            {head.map((column) => (
              <th key={column} className="whitespace-nowrap px-3 py-2 font-medium">{column}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNotice({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-lg border border-negative/30 bg-negative/10 p-4">
      <p className="text-sm font-semibold text-negative">{title}</p>
      <p className="mt-1 text-sm text-ink-muted">{message}</p>
    </div>
  );
}

export function PageHeader({ title, description, actions }: {
  title: string; description?: string; actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function LinkButton({ href, children, variant = "secondary" }: {
  href: string; children: ReactNode; variant?: "primary" | "secondary";
}) {
  const classes =
    variant === "primary"
      ? "bg-accent text-white hover:opacity-90"
      : "border border-border hover:bg-surface";
  return (
    <Link href={href} className={`inline-flex items-center rounded px-3 py-1.5 text-sm font-medium ${classes}`}>
      {children}
    </Link>
  );
}

export function DefinitionList({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="divide-y divide-border">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4 py-2">
          <dt className="text-sm text-ink-muted">{label}</dt>
          <dd className="text-sm font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ExternalLink({
  href,
  children,
  strong = false,
}: {
  href: string | null | undefined;
  children: ReactNode;
  strong?: boolean;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 text-accent hover:underline ${
        strong ? "text-sm font-medium" : "text-xs font-medium"
      }`}
    >
      {children}
      <span aria-hidden="true">↗</span>
    </a>
  );
}
