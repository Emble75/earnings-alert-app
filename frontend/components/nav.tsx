"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** What research needs, in the order you use it. */
const RESEARCH_LINKS: Array<[string, string]> = [
  ["/find", "Find deals"],
  ["/research", "Check a product"],
  ["/opportunities", "Opportunities"],
  ["/dashboard", "Overview"],
  ["/products", "Products"],
  ["/analytics", "Analytics"],
  ["/risk", "Risk"],
  ["/settings", "Settings"],
];

/** Everything, once the system is allowed to act. */
const FULL_LINKS: Array<[string, string]> = [
  ["/find", "Find deals"],
  ["/dashboard", "Dashboard"],
  ["/research", "Check a product"],
  ["/opportunities", "Opportunities"],
  ["/products", "Products"],
  ["/listings", "Listings"],
  ["/orders", "Orders"],
  ["/fulfillment", "Fulfillment"],
  ["/shipments", "Shipments"],
  ["/returns", "Returns"],
  ["/analytics", "Analytics"],
  ["/price-history", "Price history"],
  ["/risk", "Risk"],
  ["/settings", "Settings"],
  ["/logs", "Logs"],
];

export function Nav({ researchMode = false }: { researchMode?: boolean }) {
  const pathname = usePathname();
  // The selling, shipping and returns pages cannot do anything in research
  // mode. Showing them is clutter that makes the tool look harder than it is.
  const links = researchMode ? RESEARCH_LINKS : FULL_LINKS;
  return (
    <nav className="flex flex-col gap-0.5">
      {links.map(([href, label]) => {
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
