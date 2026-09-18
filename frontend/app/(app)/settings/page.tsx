import { Card, ErrorNotice, PageHeader } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";
import { titleCase } from "@/lib/format";

import { saveSettings } from "./actions";

export const dynamic = "force-dynamic";

const GROUP_HELP: Record<string, string> = {
  profitability: "The floors an opportunity must clear. Raising these reduces noise; lowering them increases false positives.",
  matching: "How certain the system must be that the source and target are the same product.",
  risk: "The deterministic risk ceiling, and the cash haircuts applied for return exposure.",
  capital: "Hard limits enforced server-side. The interface cannot bypass them.",
  freshness: "How old an observation may be before it must be refreshed. Nothing irreversible runs on stale data.",
  fulfillment: "Actual cash costs only. Manual handling by the operator is deliberately not priced.",
  delivery: "What the buyer is promised, and what the source must be able to meet.",
  policy: "What to do when information is missing or contradictory.",
  automation: "How much the system may do without asking.",
  pricing: "Listing price behaviour and the anomaly threshold.",
  fees: "Marketplace and payment fee schedules (JSON).",
  general: "Miscellaneous.",
};

export default async function SettingsPage() {
  let settings;
  try {
    settings = await api.settings();
  } catch (error) {
    return <ErrorNotice title="Could not load settings" message={error instanceof ApiRequestError ? error.message : String(error)} />;
  }

  const runtime = settings.runtime as Record<string, unknown>;

  return (
    <>
      <PageHeader
        title="Settings"
        description="Every business rule is editable here and stored in the database. Changes are validated as a whole and audited."
      />

      <Card title="Runtime" subtitle="Set in the environment, not here">
        <dl className="grid gap-3 sm:grid-cols-3">
          {Object.entries(runtime).map(([key, value]) => (
            <div key={key} className="rounded border border-border p-3">
              <dt className="text-xs text-ink-muted">{titleCase(key)}</dt>
              <dd className="mt-1 break-words text-sm font-medium">
                {typeof value === "object" ? JSON.stringify(value) : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      <form action={saveSettings} className="space-y-4">
        {Object.entries(settings.groups).map(([group, fields]) => (
          <Card key={group} title={titleCase(group)} subtitle={GROUP_HELP[group]}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {fields.map((field) => {
                const value = settings.values[field];
                const isBoolean = typeof value === "boolean";
                const isObject = typeof value === "object" && value !== null;
                return (
                  <div key={field}>
                    <label htmlFor={field} className="text-xs font-medium text-ink-muted">
                      {titleCase(field)}
                    </label>
                    {isBoolean ? (
                      <select
                        id={field}
                        name={field}
                        defaultValue={String(value)}
                        className="mt-1 w-full rounded border border-border bg-surface-raised px-3 py-2 text-sm"
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : isObject ? (
                      <textarea
                        id={field}
                        name={field}
                        rows={4}
                        defaultValue={JSON.stringify(value, null, 2)}
                        className="numeric mt-1 w-full rounded border border-border bg-surface-raised px-3 py-2 text-xs"
                        readOnly
                      />
                    ) : (
                      <input
                        id={field}
                        name={field}
                        defaultValue={String(value ?? "")}
                        className="numeric mt-1 w-full rounded border border-border bg-surface-raised px-3 py-2 text-sm"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
        <button type="submit" className="rounded bg-accent px-4 py-2 text-sm font-medium text-white">
          Save settings
        </button>
        <p className="text-xs text-ink-muted">
          Fee schedules are shown read-only here; edit them through the API so the JSON is validated
          against the fee model before it reaches the profit engine.
        </p>
      </form>
    </>
  );
}
