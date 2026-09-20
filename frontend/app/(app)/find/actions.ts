"use server";

import { ApiRequestError, api } from "@/lib/api";
import type { ScanResponse } from "@/types/api";

export interface ScanActionResult {
  ok: boolean;
  message?: string;
  data?: ScanResponse;
}

export async function runScan(
  _previous: unknown,
  formData: FormData,
): Promise<ScanActionResult> {
  const text = (name: string) => String(formData.get(name) ?? "").trim();
  const number = (name: string) => {
    const raw = text(name).replace(",", ".");
    return raw === "" ? null : Number(raw);
  };

  const query = text("query");
  const categories = text("category_ids")
    .split(/[\s,]+/)
    .filter(Boolean);

  if (!query && categories.length === 0) {
    return { ok: false, message: "Enter something to search for, or a category number." };
  }

  try {
    const data = await api.scan({
      query,
      category_ids: categories,
      min_price: number("min_price"),
      max_price: number("max_price"),
      pages: Number(text("pages") || "1"),
      detail_budget: Number(text("detail_budget") || "40"),
    });
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof ApiRequestError ? error.message : "the scan failed",
    };
  }
}
