import Link from "next/link";

const SECTIONS = [
  { href: "/settings", label: "Workspace" },
  { href: "/settings/products", label: "Products" },
  { href: "/settings/categories", label: "Categories" },
  { href: "/settings/saved-replies", label: "Saved replies" },
  { href: "/connections", label: "Connections" },
  { href: "/keys", label: "API keys" },
];

/** The settings' sections, the same at the top of each. */
export function SettingsNav() {
  return (
    <nav aria-label="Settings" className="mb-8 flex flex-wrap gap-x-4 gap-y-1 border-b pb-3 text-sm text-muted-foreground">
      {SECTIONS.map((section) => (
        <Link key={section.href} href={section.href} className="transition-colors hover:text-foreground">
          {section.label}
        </Link>
      ))}
    </nav>
  );
}
