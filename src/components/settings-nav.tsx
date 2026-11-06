import Link from "next/link";

const SECTIONS = [
  { href: "/settings", label: "Workspace" },
  { href: "/settings/products", label: "Products" },
  { href: "/settings/categories", label: "Categories" },
  { href: "/settings/saved-replies", label: "Saved replies" },
  { href: "/connections", label: "Connections" },
  { href: "/keys", label: "API keys" },
];

/** The settings' sections, the same at the top of each, with the one you're in marked. */
export function SettingsNav({ current }: { current: string }) {
  return (
    <nav aria-label="Settings" className="mb-8 flex flex-wrap gap-x-5 gap-y-1 border-b text-sm text-muted-foreground">
      {SECTIONS.map((section) => (
        <Link key={section.href} href={section.href} aria-current={section.href === current ? "page" : undefined} className="-mb-px border-b-2 border-transparent pb-3 transition-colors hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-foreground">
          {section.label}
        </Link>
      ))}
    </nav>
  );
}
