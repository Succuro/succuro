import { BRAND } from "@/domain/brand";

/** The mark: two hooks catching each other to make an S, one coming down, the other running under to lift it. */
export function LogoMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={`shrink-0 ${className}`}>
      <rect width="32" height="32" rx="7" fill="#0a3d30" />
      <path d="M23 8.5H13.5a4.5 4.5 0 0 0-1.6 8.7" fill="none" stroke="#fff" strokeWidth={4.6} strokeLinecap="round" />
      <path d="M9 23.5h9.5a4.5 4.5 0 0 0 1.6-8.7l-5.2-1.7" fill="none" stroke="#d6f23c" strokeWidth={4.6} strokeLinecap="round" />
    </svg>
  );
}

/** Mark and name. */
export function Logo() {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <LogoMark />
      <span className="truncate font-heading text-[1.15rem] font-bold tracking-[-0.03em]">{BRAND}</span>
    </span>
  );
}
