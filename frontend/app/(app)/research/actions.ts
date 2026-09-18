"use server";

import { revalidatePath } from "next/cache";

import { ApiRequestError, api } from "@/lib/api";
import type { ResearchResponse } from "@/types/api";

export interface ResearchActionResult {
  ok: boolean;
  message?: string;
  data?: ResearchResponse;
}

/**
 * Analyse products the operator pasted in as CSV.
 *
 * The backend does the parsing and validation so the browser and the API
 * agree on exactly one interpretation of a file.
 */
export async function analyseCsv(_previous: unknown, formData: FormData): Promise<ResearchActionResult> {
  const csv = String(formData.get("csv") ?? "").trim();
  if (!csv) {
    return { ok: false, message: "Paste at least one row, or upload a file." };
  }
  try {
    const data = await api.researchCsv(csv);
    revalidatePath("/research");
    revalidatePath("/opportunities");
    revalidatePath("/dashboard");
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof ApiRequestError ? error.message : "the analysis failed",
    };
  }
}
