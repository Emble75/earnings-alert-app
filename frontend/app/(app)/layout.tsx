import { redirect } from "next/navigation";

import { Nav } from "@/components/nav";
import { api, isAuthenticated } from "@/lib/api";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!(await isAuthenticated())) redirect("/login");

  let mode: string | null = null;
  try {
    const health = await api.health();
    mode = health.demo_mode
      ? "DEMO MODE - no real transactions"
      : health.simulation_mode
        ? "SIMULATION MODE - no real transactions"
        : null;
  } catch {
    mode = "backend unreachable";
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-[1400px] gap-6 px-4 py-6">
      <aside className="w-48 shrink-0">
        <p className="px-3 text-sm font-semibold">Arbitrage</p>
        <p className="mb-4 px-3 text-xs text-ink-muted">sell-first operations</p>
        <Nav />
        <form action="/api/auth/logout" method="post" className="mt-6 px-3">
          <button type="submit" className="text-xs text-ink-muted hover:text-ink">Sign out</button>
        </form>
      </aside>
      <main className="min-w-0 flex-1 space-y-6">
        {mode && (
          <p className="rounded border border-caution/30 bg-caution/10 px-3 py-2 text-xs font-medium text-caution">
            {mode}
          </p>
        )}
        {children}
      </main>
    </div>
  );
}
