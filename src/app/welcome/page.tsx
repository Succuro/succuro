import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { mayStartWorkspace, startWorkspace, workspacesOf } from "@/application/workspaces";
import { Loading, Standalone } from "@/components/shell";
import { SignOutButton } from "@/components/sign-out-button";
import { Card, FIELD, PrimaryButton } from "@/components/ui";
import { safeNext } from "@/domain/safe-next";
import { currentMember, enterWorkspace } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { env } from "@/infrastructure/env";

export const metadata: Metadata = { title: "Welcome" };

async function create(formData: FormData) {
  "use server";
  const member = await currentMember();
  if (!member) redirect("/sign-in");
  const created = await startWorkspace(db(), env(), member, String(formData.get("name") ?? ""));
  if (created) await enterWorkspace(created);
  redirect(safeNext(formData.get("next")));
}

/** Someone with an account and no workspace who may not start one: an invitation that was cancelled, or a workspace they were taken out of. */
function NoWorkspace() {
  return (
    <Card className="mt-8 w-full max-w-md">
      <h1 className="text-xl font-bold tracking-[-0.025em]">You don’t have access to any workspace</h1>
      <p className="mt-2 text-sm text-muted-foreground">Workspaces here are joined by invitation: ask the person who runs yours for a new link, then open it.</p>
      <div className="mt-5 text-sm text-muted-foreground">
        <SignOutButton />
      </div>
    </Card>
  );
}

/** Sent on when the member may not start a workspace and has one; asks those who may to name a new one, their first or another. */
async function Form({ searchParams }: { searchParams: PageProps<"/welcome">["searchParams"] }) {
  const { next } = await searchParams;
  const member = await currentMember();
  if (!member) redirect("/sign-in");
  const hasWorkspace = (await workspacesOf(db(), member.userId)).length > 0;
  if (!mayStartWorkspace(member.email, env())) {
    if (hasWorkspace) redirect(safeNext(next));
    return <NoWorkspace />;
  }
  return (
    <Card className="mt-8 w-full max-w-md">
      <h1 className="text-xl font-bold tracking-[-0.025em]">Which company is this desk for?</h1>
      <p className="mt-2 text-sm text-muted-foreground">Each workspace keeps its products, tickets and connections to itself.</p>
      <form action={create} className="mt-5 flex flex-col gap-3">
        <input type="hidden" name="next" value={safeNext(next)} />
        <input name="name" required maxLength={80} placeholder="Acme" aria-label="Company name" className={FIELD} />
        <PrimaryButton type="submit">Start the workspace</PrimaryButton>
      </form>
      {hasWorkspace && (
        <p className="mt-4 text-center text-sm">
          <Link href={safeNext(next)} className="text-muted-foreground hover:text-foreground">
            Cancel
          </Link>
        </p>
      )}
    </Card>
  );
}

/** The first thing a new member sees, and where an admin starts another: a workspace, named. */
export default function WelcomePage({ searchParams }: PageProps<"/welcome">) {
  return (
    <Standalone>
      <Suspense fallback={<Loading />}>
        <Form searchParams={searchParams} />
      </Suspense>
    </Standalone>
  );
}
