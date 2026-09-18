"use server";

/**
 * Every state-changing operation the console can trigger.
 *
 * One dispatcher, imported directly by the client component that renders the
 * buttons. Nothing but serialisable data (a kind and an id) crosses the
 * server/client boundary, and every failure the backend reports - a stale
 * revalidation, a capital limit, a compliance block - is returned verbatim so
 * the operator sees the real reason rather than a generic failure.
 */

import { revalidatePath } from "next/cache";

import { ApiRequestError, api } from "@/lib/api";

export type ActionKind =
  | "discover"
  | "revalidate-opportunity"
  | "reject-opportunity"
  | "publish-listing"
  | "revalidate-order"
  | "approve-order"
  | "receive"
  | "inspect"
  | "repack"
  | "ship";

export interface ActionResult {
  ok: boolean;
  message?: string;
}

function refreshAll(id?: number) {
  revalidatePath("/dashboard");
  revalidatePath("/opportunities");
  revalidatePath("/orders");
  revalidatePath("/listings");
  revalidatePath("/fulfillment");
  revalidatePath("/shipments");
  if (id !== undefined) {
    revalidatePath(`/orders/${id}`);
    revalidatePath(`/opportunities/${id}`);
  }
}

export async function performAction(kind: ActionKind, id: number): Promise<ActionResult> {
  try {
    switch (kind) {
      case "discover":
        await api.discover("", 25);
        break;
      case "revalidate-opportunity":
        await api.revalidateOpportunity(id);
        break;
      case "reject-opportunity":
        await api.rejectOpportunity(id, "rejected by operator");
        break;
      case "publish-listing": {
        // Creating the candidate computes the minimum viable sale price;
        // publishing revalidates again before the listing goes live.
        const candidate = await api.createListingCandidate(id);
        await api.publishListing(candidate.listing.id);
        break;
      }
      case "revalidate-order": {
        const result = await api.revalidateOrder(id);
        if (!result.ok) {
          refreshAll(id);
          return { ok: false, message: result.problems.join("; ") };
        }
        break;
      }
      case "approve-order":
        // The single approval, immediately followed by the purchase it
        // authorises. Both are idempotent server-side.
        await api.approveOrder(id, "approved from the operator console");
        await api.executeOrder(id);
        break;
      case "receive":
        await api.receive(id, { received_quantity: 1, package_intact: true });
        break;
      case "inspect":
        await api.inspect(id, { observed_condition: "NEW", accessories_complete: true });
        break;
      case "repack":
        await api.repack(id, { original_package_usable: false, reason: "" });
        break;
      case "ship":
        await api.ship(id, {});
        break;
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof ApiRequestError ? error.message : "the request failed",
    };
  }
  refreshAll(id);
  return { ok: true };
}
