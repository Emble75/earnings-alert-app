import { redirect } from "next/navigation";

import { api, authRequired, isAuthenticated } from "@/lib/api";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // A local install with sign-in disabled has nothing to ask for.
  if (!(await authRequired())) redirect("/dashboard");
  if (await isAuthenticated()) redirect("/dashboard");
  const { error } = await searchParams;

  let demoMode = false;
  let reachable = true;
  try {
    demoMode = (await api.health()).demo_mode;
  } catch {
    reachable = false;
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold">Arbitrage Platform</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Amazon to eBay, sell-first. Sign in to continue.
        </p>

        {!reachable && (
          <p className="mt-4 rounded border border-negative/30 bg-negative/10 p-3 text-sm text-negative">
            The backend is not reachable. Start it with <code>docker compose up</code> or
            <code> uvicorn app.main:app</code>.
          </p>
        )}
        {demoMode && (
          <p className="mt-4 rounded border border-caution/30 bg-caution/10 p-3 text-sm text-caution">
            Demo mode is active: no marketplace credentials are configured, so no real
            listing, purchase or shipment can occur.
          </p>
        )}
        {error && (
          <p className="mt-4 rounded border border-negative/30 bg-negative/10 p-3 text-sm text-negative">
            {error}
          </p>
        )}

        <form action="/api/auth/login" method="post" className="mt-6 space-y-3">
          <div>
            <label htmlFor="email" className="text-xs font-medium text-ink-muted">Email</label>
            <input
              id="email" name="email" type="email" required autoComplete="username"
              className="mt-1 w-full rounded border border-border bg-surface-raised px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="password" className="text-xs font-medium text-ink-muted">Password</label>
            <input
              id="password" name="password" type="password" required autoComplete="current-password"
              className="mt-1 w-full rounded border border-border bg-surface-raised px-3 py-2 text-sm"
            />
          </div>
          <button type="submit" className="w-full rounded bg-accent px-3 py-2 text-sm font-medium text-white">
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
