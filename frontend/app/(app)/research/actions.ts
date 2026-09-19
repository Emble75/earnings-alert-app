"use server";

import { revalidatePath } from "next/cache";

import { ApiRequestError, api } from "@/lib/api";
import type { ResearchResponse } from "@/types/api";

export interface ResearchActionResult {
  ok: boolean;
  message?: string;
  data?: ResearchResponse;
}

function refresh() {
  revalidatePath("/research");
  revalidatePath("/opportunities");
  revalidatePath("/dashboard");
}

function failure(error: unknown): ResearchActionResult {
  return {
    ok: false,
    message: error instanceof ApiRequestError ? error.message : "the analysis failed",
  };
}

/** Check one product. The common case, so it gets the simplest path. */
export async function checkOneProduct(
  _previous: unknown,
  formData: FormData,
): Promise<ResearchActionResult> {
  const text = (name: string) => String(formData.get(name) ?? "").trim();

  const brand = text("brand");
  const model = text("model");
  const ean = text("ean");
  const sourcePrice = text("source_price").replace(",", ".");
  const targetPrice = text("target_price").replace(",", ".");

  const missing = [
    !brand && "brand",
    !model && "model",
    !ean && "EAN",
    !sourcePrice && "Amazon price",
    !targetPrice && "eBay sold price",
  ].filter(Boolean);
  if (missing.length > 0) {
    return { ok: false, message: `Still needed: ${missing.join(", ")}.` };
  }

  const title = text("title") || `${brand} ${model}`;
  const deliveryDays = text("source_delivery_days");

  try {
    const data = await api.research([
      {
        title,
        brand,
        model,
        ean,
        source_price: sourcePrice,
        target_price: targetPrice,
        source_stock: text("source_stock") || "IN_STOCK",
        source_delivery_days: deliveryDays ? Number(deliveryDays) : 2,
        source_shipping: text("source_shipping").replace(",", ".") || "0",
        condition: "NEW",
      },
    ]);
    refresh();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Check several at once, pasted as CSV. */
export async function analyseCsv(
  _previous: unknown,
  formData: FormData,
): Promise<ResearchActionResult> {
  const csv = String(formData.get("csv") ?? "").trim();
  if (!csv) {
    return { ok: false, message: "Paste at least one row." };
  }
  try {
    const data = await api.researchCsv(csv);
    refresh();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}
