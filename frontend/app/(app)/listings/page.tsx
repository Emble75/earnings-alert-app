import { Card, EmptyState, ErrorNotice, Money, PageHeader, StateBadge, Table } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";
import { dateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ListingsPage() {
  let page;
  try {
    page = await api.listings();
  } catch (error) {
    return <ErrorNotice title="Could not load listings" message={error instanceof ApiRequestError ? error.message : String(error)} />;
  }

  return (
    <>
      <PageHeader
        title="Listings"
        description="Our own listings. A listing is only published above its computed minimum viable sale price."
      />
      <Card title={`${page.total} listing${page.total === 1 ? "" : "s"}`}>
        {page.items.length === 0 ? (
          <EmptyState title="Nothing listed" body="Publish a listing from an actionable opportunity to sell first." />
        ) : (
          <Table head={["SKU", "Title", "State", "Price", "Minimum viable", "Qty", "Published"]}>
            {page.items.map((listing) => (
              <tr key={listing.id}>
                <td className="px-3 py-2 font-medium">{listing.sku ?? "—"}</td>
                <td className="max-w-xs truncate px-3 py-2">{listing.title}</td>
                <td className="px-3 py-2"><StateBadge state={listing.state} /></td>
                <td className="px-3 py-2"><Money value={listing.price} currency={listing.currency} /></td>
                <td className="px-3 py-2"><Money value={listing.minimum_sale_price} currency={listing.currency} /></td>
                <td className="numeric px-3 py-2">{listing.quantity}</td>
                <td className="px-3 py-2 text-xs text-ink-muted">{dateTime(listing.published_at)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
