import { Card, ErrorNotice, PageHeader } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";
import { titleCase } from "@/lib/format";

import { saveSettings } from "./actions";

/** Fields whose value is one of a fixed set, rendered as a menu. */
const CHOICES: Record<string, Array<[string, string]>> = {
  vat_scheme: [
    ["SMALL_BUSINESS", "Small business (§19 UStG) - no VAT on sales"],
    ["STANDARD", "Standard - VAT due on every sale"],
  ],
  fulfillment_mode: [["MANUAL", "Manual (you pack and post)"]],
};

/** Help for the fields where a wrong answer is silent and expensive. */
const FIELD_HELP: Record<string, string> = {
  vat_scheme:
    "Small business is the default and changes nothing. Standard deducts the VAT from every sale price.",
  vat_rate_percent: "As a percentage: 19, not 0.19 and not 1.19.",
  reclaim_input_vat_on_purchase:
    "Only if Amazon issues you an invoice showing the VAT. Off costs you real margin; on without an invoice overstates every deal.",
  reclaim_input_vat_on_fees:
    "eBay usually invoices German business sellers under the reverse charge, in which case there is no input VAT to reclaim. Leave off unless your invoices show German VAT.",
  reclaim_input_vat_on_costs: "Postage and packaging bought with a VAT invoice.",
};

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
  vat: "How you are taxed. This is the single largest correction to a naive margin - a standard-rate seller keeps 100/119 of the sale price, not all of it - so an answer here changes every verdict. Not tax advice: set what your accountant says applies to you.",
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
                    {CHOICES[field] ? (
                      <select
                        id={field}
                        name={field}
                        defaultValue={String(value)}
                        className="mt-1 w-full rounded border border-border bg-surface-raised px-3 py-2 text-sm"
                      >
                        {CHOICES[field].map(([option, label]) => (
                          <option key={option} value={option}>{label}</option>
                        ))}
                      </select>
                    ) : isBoolean ? (
                      <select
                        id={field}
                        name={field}
                        defaultValue={String(value)}
                        className="mt-1 w-full rounded border border-border bg-surface-raised px-3 py-2 text-sm"
                      >
                        <option value="true">yes</option>
                        <option value="false">no</option>
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
                    {FIELD_HELP[field] && (
                      <p className="mt-1 text-xs text-ink-muted">{FIELD_HELP[field]}</p>
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
