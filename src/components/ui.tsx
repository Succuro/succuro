import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";

const BUTTON = "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY = `${BUTTON} bg-primary font-semibold text-primary-foreground hover:bg-primary-hover`;
const QUIET = `${BUTTON} border bg-card text-foreground hover:bg-accent`;

/** The page's main action, in the brand's colour: there is one per place. */
export function PrimaryButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`${PRIMARY} ${className}`} />;
}

export function QuietButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`${QUIET} ${className}`} />;
}

/** The page's main action, when it only leads somewhere. */
export function PrimaryLink({ className = "", ...props }: ComponentProps<typeof Link>) {
  return <Link {...props} className={`${PRIMARY} ${className}`} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border bg-card p-6 ${className}`}>{children}</div>;
}

/** What a list shows with nothing in it: what belongs here, and how the first one gets there. */
export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-input px-6 py-8 text-center">
      <p className="font-heading font-bold tracking-[-0.015em]">{title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/** Whether a connection works, at a glance. */
export function StatusDot({ status }: { status: "connected" | "failing" }) {
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${status === "connected" ? "bg-calm" : "bg-alert"}`} />;
}

/** A short label beside a title: a status, a priority. */
export function Badge({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "calm" | "alert" }) {
  const colours = { plain: "text-muted-foreground", calm: "border-calm/40 bg-calm/10 text-calm", alert: "border-alert/50 bg-alert/10 text-alert" };
  return <span className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 font-mono text-[11px] leading-4 ${colours[tone]}`}>{children}</span>;
}

/** A value to copy: an address, a key, a command. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="block rounded-lg border bg-surface px-3 py-2 font-mono text-xs break-all">{children}</code>;
}

/** The look of a field beside others in a row, as wide as what it holds. Phones get the size that stops them zooming in on focus. */
export const INLINE_FIELD = "rounded-lg border border-input bg-card px-3 py-2 text-base outline-none transition-shadow focus:border-ring focus:ring-2 focus:ring-ring/30 sm:text-sm";

/** The look of every text field and list in a form. */
export const FIELD = `w-full ${INLINE_FIELD}`;

/** A label over its field. */
export function Labelled({ label, hint, className = "", children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 text-sm font-medium ${className}`}>
      {label}
      {children}
      {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
    </label>
  );
}
