"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Make invoice" },
  { href: "/invoices", label: "Invoices" },
  { href: "/help", label: "Help" },
];

export default function Nav() {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <nav className="app-nav" aria-label="Main">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className="app-navlink" aria-current={isActive(l.href) ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
