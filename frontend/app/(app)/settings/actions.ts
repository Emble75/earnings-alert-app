"use server";

import { revalidatePath } from "next/cache";

import { ApiRequestError, api } from "@/lib/api";

export async function saveSettings(formData: FormData): Promise<void> {
  const updates: Record<string, unknown> = {};
  for (const [key, raw] of formData.entries()) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value === "") continue;
    if (value === "true" || value === "false") {
      updates[key] = value === "true";
    } else {
      updates[key] = value;
    }
  }
  try {
    await api.updateSettings(updates);
  } catch (error) {
    if (error instanceof ApiRequestError) throw new Error(error.message);
    throw error;
  }
  revalidatePath("/settings");
  revalidatePath("/opportunities");
  revalidatePath("/dashboard");
}
