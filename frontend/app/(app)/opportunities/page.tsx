import { ActionButton } from "@/components/actions";
import {
  Badge, Card, EmptyState, ErrorNotice, ExternalLink, LinkButton, Money, PageHeader, StateBadge, Table,
} from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";
import { confidence, percent, riskTone } from "@/lib/format";

export const dynamic = "force-dynamic";

const SORTS: Array<[string, string]> = [
  ["expected_net_profit", "Net profit"],
  ["profit_margin", "Margin"],
  ["roi", "ROI"],
  ["risk_score", "Risk"],
  ["match_confidence", "Match confidence"],
  ["capital_required", "Capital"],
  ["created_at", "Discovered"],
];

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; order?: string; all?: string }>;
}) {
  const params = await searchParams;
  const sort = params.sort ?? "expected_net_profit";
  const order = params.order === "asc" ? "asc" : "desc";
  const showAll = params.all === "1";

  // In research mode there is no live source feed: discovery can only return
  // the built-in example catalogue, which is the same ten products every time.
  // Offering it as "discovery" makes examples look like findings, so it is
  // replaced by the one thing that does produce real rows here.
  let researchMode = false;
  try {
    researchMode = (await api.health()).research_mode === true;
  } catch {
    researchMode = false;
  }

  let page;
  try {
    page = await api.opportunities({
      sort,
      order,
      limit: 100,
      apply_defaults: !showAll,
      ...(showAll ? { state: undefined } : {}),
    });
  } catch (error) {
    return (
      <ErrorNotice
        title="Could not load opportunities"
        message={error instanceof ApiRequestError ? error.message : String(error)}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Opportunities"
        description={
          showAll
            ? "All states, thresholds not applied. This view includes rejected and blocked rows."
            : "Filtered by the configured thresholds: minimum net profit, minimum margin, maximum risk and minimum match confidence."
        }
        actions={
          <div className="flex gap-2">
            <LinkButton href={showAll ? "/opportunities" : "/opportunities?all=1"}>
              {showAll ? "Apply default filters" : "Show everything"}
            </LinkButton>
            {researchMode ? (
              <LinkButton href="/research" variant="primary">Check a product</LinkButton>
            ) : (
              <ActionButton
                kind="discover"
                id={0}
                label="Run discovery"
                pendingLabel="Discovering..."
                variant="primary"
              />
            )}
          </div>
        }
      />

      <Card
        title={`${page.total} opportunit${page.total === 1 ? "y" : "ies"}`}
        subtitle="Sort by any objective metric. No subjective ranking is applied."
        actions={
          <div className="flex flex-wrap gap-1">
            {SORTS.map(([key, label]) => (
              <LinkButton
                key={key}
                href={`/opportunities?sort=${key}&order=${sort === key && order === "desc" ? "asc" : "desc"}${showAll ? "&all=1" : ""}`}
              >
                {label}
                {sort === key ? (order === "desc" ? " ↓" : " ↑") : ""}
              </LinkButton>
            ))}
          </div>
        }
      >
        {page.items.length === 0 ? (
          <EmptyState
            title="Nothing meets the thresholds"
            body={
              researchMode
                ? "That is the system working as intended: it is tuned to reduce false positives, not to maximise the number of rows. Check a product under Research, or relax the thresholds in Settings."
                : "That is the system working as intended: it is tuned to reduce false positives, not to maximise the number of rows. Run discovery, or relax the thresholds in Settings."
            }
          />
        ) : (
          <Table
            head={["Product", "State", "Source", "Target", "Net profit", "Margin", "ROI", "Risk", "Match", "Check", ""]}
          >
            {page.items.map((item) => (
              <tr key={item.id}>
                <td className="max-w-[18rem] px-3 py-2">
                  <div className="truncate font-medium" title={item.product?.title ?? undefined}>
                    {item.product?.title ?? item.reference}
                  </div>
                  <div className="numeric truncate text-xs text-ink-muted">
                    {[item.product?.brand, item.product?.primary_identifier_value]
                      .filter(Boolean)
                      .join(" · ") || item.reference}
                  </div>
                </td>
                <td className="px-3 py-2"><StateBadge state={item.state} /></td>
                <td className="px-3 py-2"><Money value={item.source_price} currency={item.currency} /></td>
                <td className="px-3 py-2"><Money value={item.target_price} currency={item.currency} /></td>
                <td className="px-3 py-2"><Money value={item.expected_net_profit} currency={item.currency} signed /></td>
                <td className="numeric px-3 py-2">{percent(item.profit_margin)}</td>
                <td className="numeric px-3 py-2">{percent(item.roi)}</td>
                <td className="px-3 py-2">
                  <Badge tone={riskTone(item.risk_score)}>{item.risk_score ?? "—"}</Badge>
                </td>
                <td className="numeric px-3 py-2">{confidence(item.match_confidence)}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <ExternalLink href={item.links?.source_product}>Amazon</ExternalLink>
                    <ExternalLink href={item.links?.target_sold}>eBay sold</ExternalLink>
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  <LinkButton href={`/opportunities/${item.id}`}>Open</LinkButton>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
