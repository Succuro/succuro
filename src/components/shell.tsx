import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { mayStartWorkspace } from "@/application/workspaces";
import { currentMember, workspacesInBrowser, type Member } from "@/infrastructure/auth/session";
import { env } from "@/infrastructure/env";
import { Logo } from "./logo";
import { SignOutButton } from "./sign-out-button";
import { WorkspaceMenu } from "./workspace-menu";

const NAV = [
  { href: "/tickets", label: "Inbox", section: "inbox" },
  { href: "/settings", label: "Settings", section: "settings" },
] as const;

type Section = (typeof NAV)[number]["section"];

/** Which workspace this is and the way to another. With nothing else to reach, there's nothing to choose and nothing shows. */
async function WorkspaceSwitcher({ member }: { member: Member }) {
  const { workspaces, active } = await workspacesInBrowser(member.userId);
  const mayStart = mayStartWorkspace(member.email, env());
  if (!active || (workspaces.length === 1 && !mayStart)) return null;
  const others = workspaces.filter(({ id }) => id !== active.id).map(({ id, name }) => ({ id, name }));
  return <WorkspaceMenu current={active.name} others={others} mayStart={mayStart} />;
}

/** Who is signed in and where, streamed in once the session is read. */
async function WhoIsSignedIn() {
  const member = await currentMember();
  if (!member) return null;
  return (
    <span className="flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
      <WorkspaceSwitcher member={member} />
      <SignOutButton />
    </span>
  );
}

/** The frame of the app's pages: the band, the mark, what's reachable with where you are marked, who is signed in. */
export function Shell({ section, children }: { section: Section; children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <div aria-hidden className="band-check" />
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-8 gap-y-2 px-4 py-3">
          <Link href="/tickets" aria-label="Inbox" className="rounded-md">
            <Logo />
          </Link>
          <nav aria-label="Main" className="order-last flex w-full flex-wrap items-center gap-x-1 gap-y-1 text-sm text-muted-foreground sm:order-none sm:w-auto sm:flex-1">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} aria-current={item.section === section ? "page" : undefined} className="rounded-lg px-3 py-1.5 transition-colors hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground">
                {item.label}
              </Link>
            ))}
          </nav>
          <Suspense>
            <WhoIsSignedIn />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 md:py-10">{children}</main>
    </div>
  );
}

/** A page outside the app's frame, for someone signing in, joining or answering: the band and the mark over what it's for. */
export function Standalone({ align = "center", children }: { align?: "center" | "top"; children: ReactNode }) {
  return (
    <>
      <div aria-hidden className="band-check" />
      <main className={`flex flex-1 flex-col items-center px-4 ${align === "center" ? "justify-center py-16" : "py-12"}`}>
        <Logo />
        {children}
      </main>
    </>
  );
}

/** A page's heading and the sentence that says what it's for. */
export function PageHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-8">
      <h1 className="text-3xl font-bold tracking-[-0.03em] md:text-4xl">{title}</h1>
      {children && <p className="mt-3 max-w-2xl text-muted-foreground">{children}</p>}
    </div>
  );
}

/** Quiet placeholder while the server reads the workspace. */
export function Loading() {
  return <p className="font-mono text-xs text-muted-foreground">Loading…</p>;
}
