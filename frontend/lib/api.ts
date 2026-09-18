/**
 * Typed API client.
 *
 * The access token lives in an httpOnly cookie set by the login route
 * handler, so page components never touch it and it is not reachable from
 * client-side JavaScript.
 */

import { cookies } from "next/headers";

import type {
  Analytics, ApprovalSummary, AuditEntry, Backtest, Health, Listing, Opportunity,
  OpportunityDetail, Order, OrderDetail, Page, ResearchResponse, ReturnRecord,
  SettingsPayload, Shipment,
} from "@/types/api";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:8000";

export const TOKEN_COOKIE = "arb_token";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    // Trading data goes stale in minutes; never serve it from a cache.
    cache: "no-store",
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let code = "http_error";
    let context: Record<string, unknown> = {};
    try {
      const body = await response.json();
      if (body?.error) {
        message = body.error.message ?? message;
        code = body.error.code ?? code;
        context = body.error.context ?? {};
      }
    } catch {
      /* the body was not JSON; keep the status line */
    }
    throw new ApiRequestError(message, response.status, code, context);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function authedRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const store = await cookies();
  const token = store.get(TOKEN_COOKIE)?.value;
  return request<T>(path, init, token);
}

/**
 * Whether the console may be used.
 *
 * True with a token, and also when the backend reports that sign-in is not
 * required - a single-user install on this machine, which the backend only
 * permits while it cannot list, buy or ship.
 */
export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  if (store.get(TOKEN_COOKIE)?.value) return true;
  return !(await authRequired());
}

export async function authRequired(): Promise<boolean> {
  try {
    const health = await api.health();
    return health.auth_required !== false;
  } catch {
    // If the backend cannot be reached, assume sign-in is needed rather than
    // opening the console.
    return true;
  }
}

export async function login(email: string, password: string): Promise<string> {
  const body = await request<{ access_token: string }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return body.access_token;
}

export const api = {
  health: () => request<Health>("/api/health"),

  opportunities: (params: Record<string, string | number | boolean | undefined> = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString() ? `?${query}` : "";
    return authedRequest<Page<Opportunity>>(`/api/opportunities${suffix}`);
  },
  opportunity: (id: number) => authedRequest<OpportunityDetail>(`/api/opportunities/${id}`),
  discover: (query: string, limit = 20) =>
    authedRequest<unknown[]>("/api/opportunities/discover", {
      method: "POST",
      body: JSON.stringify({ query, limit, evaluate: true }),
    }),
  revalidateOpportunity: (id: number) =>
    authedRequest<unknown>(`/api/opportunities/${id}/revalidate`, { method: "POST" }),
  rejectOpportunity: (id: number, reason: string) =>
    authedRequest<unknown>(
      `/api/opportunities/${id}/reject?reason=${encodeURIComponent(reason)}`,
      { method: "POST" },
    ),

  researchTemplate: () =>
    authedRequest<{ columns: Record<string, string[]>; template_csv: string; notes: string[] }>(
      "/api/research/template",
    ),
  research: (products: Record<string, unknown>[]) =>
    authedRequest<ResearchResponse>("/api/research", {
      method: "POST",
      body: JSON.stringify({ products }),
    }),
  researchCsv: async (csv: string) => {
    // Sent as a file upload so the backend applies the same size and encoding
    // checks it would to a real uploaded file.
    const { cookies } = await import("next/headers");
    const token = (await cookies()).get(TOKEN_COOKIE)?.value;
    const form = new FormData();
    form.append("file", new Blob([csv], { type: "text/csv" }), "research.csv");
    const response = await fetch(`${API_BASE}/api/research/csv`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
      cache: "no-store",
    });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      let code = "http_error";
      try {
        const body = await response.json();
        message = body?.error?.message ?? message;
        code = body?.error?.code ?? code;
      } catch {
        /* not JSON */
      }
      throw new ApiRequestError(message, response.status, code);
    }
    return (await response.json()) as ResearchResponse;
  },

  listings: () => authedRequest<Page<Listing>>("/api/listings?own_only=true&limit=100"),
  createListingCandidate: (opportunityId: number) =>
    authedRequest<{ listing: Listing; minimum_sale_price: string; recommended_sale_price: string; expected_net_profit: string; reasons: string[] }>(
      "/api/listings",
      { method: "POST", body: JSON.stringify({ opportunity_id: opportunityId }) },
    ),
  publishListing: (id: number) =>
    authedRequest<Listing>(`/api/listings/${id}/publish`, { method: "POST" }),
  endListing: (id: number) => authedRequest<Listing>(`/api/listings/${id}`, { method: "DELETE" }),

  orders: (params: Record<string, string | number | undefined> = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const suffix = query.toString() ? `?${query}` : "";
    return authedRequest<Page<Order>>(`/api/orders${suffix}`);
  },
  order: (id: number) => authedRequest<OrderDetail>(`/api/orders/${id}`),
  pendingApprovals: () => authedRequest<OrderDetail[]>("/api/orders/pending-approval"),
  revalidateOrder: (id: number) =>
    authedRequest<{ ok: boolean; problems: string[]; checks: Record<string, string> }>(
      `/api/orders/${id}/revalidate`,
      { method: "POST" },
    ),
  approveOrder: (id: number, note: string) =>
    authedRequest<OrderDetail>(`/api/orders/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }),
  executeOrder: (id: number) =>
    authedRequest<OrderDetail>(`/api/orders/${id}/execute`, { method: "POST" }),

  receive: (id: number, body: Record<string, unknown>) =>
    authedRequest<Order>(`/api/fulfillment/${id}/receive`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  inspect: (id: number, body: Record<string, unknown>) =>
    authedRequest<Order>(`/api/fulfillment/${id}/inspect`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  repack: (id: number, body: Record<string, unknown>) =>
    authedRequest<Order>(`/api/fulfillment/${id}/repack`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  ship: (id: number, body: Record<string, unknown>) =>
    authedRequest<Shipment>(`/api/fulfillment/${id}/ship`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  shipments: () => authedRequest<Page<Shipment>>("/api/shipments?limit=100"),
  returns: () => authedRequest<Page<ReturnRecord>>("/api/returns?limit=100"),

  analytics: () => authedRequest<Analytics>("/api/analytics"),
  backtest: () => authedRequest<Backtest>("/api/analytics/backtest"),
  risk: () =>
    authedRequest<{ distribution: Record<string, number>; risk_model_version: string; recent_assessments: Array<Record<string, unknown>> }>(
      "/api/risk",
    ),
  settings: () => authedRequest<SettingsPayload>("/api/settings"),
  updateSettings: (updates: Record<string, unknown>) =>
    authedRequest<SettingsPayload>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ updates }),
    }),
  logs: (params: Record<string, string | number | undefined> = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString() ? `?${query}` : "";
    return authedRequest<{ items: AuditEntry[]; total: number }>(`/api/logs${suffix}`);
  },
  approvalSummary: (order: OrderDetail): ApprovalSummary => order.approval_summary,
};
