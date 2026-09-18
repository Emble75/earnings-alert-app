import { Card, EmptyState, ErrorNotice, PageHeader, Table } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";

export const dynamic = "force-dynamic";

interface Product {
  id: number;
  title: string;
  brand: string | null;
  model: string | null;
  category: string | null;
  condition: string;
  primary_identifier_value: string | null;
  attributes: Record<string, unknown>;
}

export default async function ProductsPage() {
  let page;
  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000"}/api/products?limit=100`,
      { cache: "no-store", headers: await authHeaders() },
    );
    if (!response.ok) throw new ApiRequestError("could not load products", response.status, "http_error");
    page = (await response.json()) as { items: Product[]; total: number };
  } catch (error) {
    return <ErrorNotice title="Could not load products" message={error instanceof ApiRequestError ? error.message : String(error)} />;
  }

  return (
    <>
      <PageHeader title="Products" description="Canonical products, independent of any marketplace." />
      <Card title={`${page.total} product${page.total === 1 ? "" : "s"}`}>
        {page.items.length === 0 ? (
          <EmptyState title="No products yet" body="Products are created by discovery." />
        ) : (
          <Table head={["Title", "Brand", "Model", "Identifier", "Condition", "Attributes"]}>
            {page.items.map((product) => (
              <tr key={product.id}>
                <td className="max-w-xs truncate px-3 py-2 font-medium">{product.title}</td>
                <td className="px-3 py-2">{product.brand ?? "—"}</td>
                <td className="px-3 py-2">{product.model ?? "—"}</td>
                <td className="numeric px-3 py-2 text-xs">{product.primary_identifier_value ?? "—"}</td>
                <td className="px-3 py-2 text-xs">{product.condition}</td>
                <td className="px-3 py-2 text-xs text-ink-muted">
                  {Object.entries(product.attributes).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(", ") || "—"}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

async function authHeaders(): Promise<Record<string, string>> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  const token = store.get("arb_token")?.value;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
