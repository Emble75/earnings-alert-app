import { notFound } from "next/navigation";

import { ActionButton } from "@/components/actions";
import { Badge, Card, DefinitionList, ErrorNotice, Money, PageHeader, StateBadge, Table } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";
import { confidence, dateTime, money, percent, riskTone, titleCase } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Cost lines in the order the approval screen must present them. */
const COST_ORDER = [
  ["source_purchase_cost", "Source purchase cost"],
  ["source_to_operator_shipping", "Source → operator shipping"],
  ["marketplace_fees", "Marketplace fees"],
  ["payment_fees", "Payment fees"],
  ["fulfillment_cost", "Fulfillment cost"],
  ["operator_to_customer_shipping", "Operator → customer shipping"],
  ["packaging", "Packaging"],
  ["expected_return_cost", "Expected return cost"],
  ["risk_reserve", "Risk reserve"],
  ["other_variable_costs", "Other variable costs"],
] as const;

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  if (Number.isNaN(numericId)) notFound();

  let order;
  try {
    order = await api.order(numericId);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    return (
      <ErrorNotice
        title="Could not load this order"
        message={error instanceof ApiRequestError ? error.message : String(error)}
      />
    );
  }

  const s = order.approval_summary;
  const problems = s.revalidation?.problems ?? [];
  const checks = s.revalidation?.checks ?? {};

  return (
    <>
      <PageHeader
        title={order.reference}
        description={`${order.provider} order ${order.external_order_id}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <ActionButton kind="revalidate-order" id={numericId} label="Revalidate" />
            {order.state === "SOURCE_PURCHASED" && (
              <ActionButton kind="receive" id={numericId} label="Mark received" variant="primary" />
            )}
            {order.state === "INSPECTION" && (
              <ActionButton kind="inspect" id={numericId} label="Record inspection pass" variant="primary" />
            )}
            {order.state === "FULFILLMENT" && (
              <>
                <ActionButton kind="repack" id={numericId} label="Repack" />
                <ActionButton kind="ship" id={numericId} label="Ship and upload tracking" variant="primary" />
              </>
            )}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <StateBadge state={order.state} />
        <Badge tone={s.execution_mode === "LIVE" ? "negative" : "caution"}>{s.execution_mode}</Badge>
        {order.risk_score !== null && <Badge tone={riskTone(order.risk_score)}>Risk {order.risk_score}</Badge>}
        {s.compliance && <Badge tone={s.compliance === "PASS" ? "positive" : "caution"}>Compliance {s.compliance}</Badge>}
      </div>

      {order.blocked_reason && <ErrorNotice title="Blocked" message={order.blocked_reason} />}
      {problems.length > 0 && (
        <ErrorNotice title="Revalidation found problems" message={problems.join("; ")} />
      )}

      <Card
        title="Source purchase approval"
        subtitle="Everything below was fetched after the sale, not when the listing was created."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Sale</h3>
            <DefinitionList
              rows={[
                ["Sell price", <Money key="p" value={s.sale.sale_price} currency={s.currency} />],
                ["Buyer paid shipping", <Money key="bs" value={s.sale.buyer_shipping_paid} currency={s.currency} />],
                ["Sold at", dateTime(s.sale.sold_at)],
                ["Delivery deadline", dateTime(s.sale.delivery_deadline)],
                ["Quantity", s.quantity],
              ]}
            />

            <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-ink-muted">Source</h3>
            <DefinitionList
              rows={[
                ["Source cost", <Money key="sc" value={s.source.price} currency={s.currency} />],
                ["Source shipping", <Money key="ss" value={s.source.shipping} currency={s.currency} />],
                ["Availability", <Badge key="av" tone={s.source.availability === "IN_STOCK" ? "positive" : "caution"}>{titleCase(s.source.availability)}</Badge>],
                ["Units available", s.source.available_quantity ?? "—"],
                [
                  "Delivery estimate",
                  s.source.delivery_estimate_days
                    ? `${s.source.delivery_estimate_days[0] ?? "?"}–${s.source.delivery_estimate_days[1] ?? "?"} days`
                    : "unknown",
                ],
                ["Seller", s.source.seller ?? "—"],
                ["Match confidence", confidence(s.match_confidence)],
              ]}
            />
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Costs</h3>
            <dl className="divide-y divide-border">
              <div className="flex items-baseline justify-between py-2">
                <dt className="text-sm">Sell price</dt>
                <dd className="text-sm font-medium"><Money value={s.sale.sale_price} currency={s.currency} /></dd>
              </div>
              {COST_ORDER.map(([key, label]) => (
                <div key={key} className="flex items-baseline justify-between py-2">
                  <dt className="text-sm text-ink-muted">{label}</dt>
                  <dd className="text-sm">
                    <Money value={s.costs[key] ? `-${s.costs[key]}` : "0.00"} currency={s.currency} />
                  </dd>
                </div>
              ))}
            </dl>

            <div className="mt-3 space-y-1 border-t border-border pt-3">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold">Expected net profit</span>
                <span className="text-xl font-semibold">
                  <Money value={s.expected_net_profit} currency={s.currency} signed />
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-ink-muted">Worst case profit</span>
                <span className="text-sm"><Money value={s.worst_case_net_profit} currency={s.currency} signed /></span>
              </div>
            </div>

            <dl className="mt-3 grid grid-cols-4 gap-2 border-t border-border pt-3 text-center text-xs">
              <div><dt className="text-ink-muted">Margin</dt><dd className="numeric font-medium">{percent(s.profit_margin)}</dd></div>
              <div><dt className="text-ink-muted">ROI</dt><dd className="numeric font-medium">{percent(s.roi)}</dd></div>
              <div><dt className="text-ink-muted">Capital</dt><dd className="numeric font-medium">{money(s.capital_required, s.currency)}</dd></div>
              <div><dt className="text-ink-muted">Risk</dt><dd className="numeric font-medium">{s.risk_score ?? "—"}</dd></div>
            </dl>

            {s.can_approve ? (
              <div className="mt-4">
                <ActionButton
                  kind="approve-order"
                  id={numericId}
                  label="APPROVE SOURCE PURCHASE"
                  pendingLabel="Purchasing..."
                  variant="primary"
                  confirm={`This will buy the item for ${money(s.source.price, s.currency)} and cannot be undone from here. Continue?`}
                />
                <p className="mt-2 text-xs text-ink-muted">
                  One approval. After this the purchase, fulfilment and shipment proceed without
                  further confirmation, within the configured risk, capital and compliance limits.
                </p>
              </div>
            ) : (
              <p className="mt-4 text-xs text-ink-muted">
                This order is not awaiting approval ({titleCase(order.state)}).
              </p>
            )}
          </div>
        </div>
      </Card>

      {Object.keys(checks).length > 0 && (
        <Card title="Revalidation checks" subtitle="Performed live, after the sale">
          <DefinitionList rows={Object.entries(checks).map(([k, v]) => [titleCase(k), String(v)])} />
        </Card>
      )}

      <Card title="History" subtitle="Every transition, timestamped">
        <Table head={["When", "Event", "From", "To", "Actor", "Message"]}>
          {order.events.map((event, index) => (
            <tr key={`${event.event_type}-${index}`}>
              <td className="px-3 py-2 text-xs text-ink-muted">{dateTime(event.occurred_at)}</td>
              <td className="px-3 py-2">{titleCase(event.event_type)}</td>
              <td className="px-3 py-2 text-xs text-ink-muted">{event.from_state ?? "—"}</td>
              <td className="px-3 py-2">{event.to_state ? <StateBadge state={event.to_state} /> : "—"}</td>
              <td className="px-3 py-2 text-xs text-ink-muted">{event.actor}</td>
              <td className="px-3 py-2 text-xs text-ink-muted">{event.message ?? ""}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
