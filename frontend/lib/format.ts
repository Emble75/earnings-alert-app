/**
 * Formatting helpers.
 *
 * These operate on the decimal strings the API returns. They never call
 * parseFloat on a monetary value for anything but display width decisions,
 * and never feed a parsed number back into a calculation.
 */

const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

export function money(value: string | null | undefined, currency = "EUR"): string {
  if (value === null || value === undefined || value === "") return "—";
  const symbol = SYMBOLS[currency] ?? "";
  const negative = value.startsWith("-");
  const bare = negative ? value.slice(1) : value;
  const [whole, fraction = "00"] = bare.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${negative ? "-" : ""}${symbol}${grouped}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

export function percent(ratio: string | null | undefined, digits = 2): string {
  if (!ratio) return "—";
  const value = Number(ratio) * 100;
  if (Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function confidence(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = Number(value);
  return Number.isNaN(parsed) ? "—" : `${parsed.toFixed(0)}%`;
}

export function isNegative(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().startsWith("-");
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-GB", {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export function relativeAge(value: string | null | undefined): string {
  if (!value) return "never observed";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function riskTone(score: number | null): "positive" | "caution" | "negative" | "muted" {
  if (score === null) return "muted";
  if (score <= 20) return "positive";
  if (score <= 40) return "caution";
  return "negative";
}
