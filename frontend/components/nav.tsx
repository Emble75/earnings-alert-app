"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: Array<[string, string]> = [
  ["/dashboard", "Dashboard"],
  ["/opportunities", "Opportunities"],
  ["/products", "Products"],
  ["/listings", "Listings"],
  ["/orders", "Orders"],
  ["/fulfillment", "Fulfillment"],
  ["/shipments", "Shipments"],
  ["/returns", "Returns"],
  ["/analytics", "Analytics"],
  ["/risk", "Risk"],
  ["/settings", "Settings"],
  ["/logs", "Logs"],
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {LINKS.map(([href, label]) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            className={`rounded px-3 py-1.5 text-sm ${
              active ? "bg-accent/10 font-medium text-accent" : "text-ink-muted hover:bg-surface hover:text-ink"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
