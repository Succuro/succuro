import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { workspacesOf, type MemberWorkspace } from "@/application/workspaces";
import { Loading, Standalone } from "@/components/shell";
import { Card } from "@/components/ui";
import { BRAND } from "@/domain/brand";
import { auth } from "@/infrastructure/auth/server";
import { currentMember } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { ConsentButtons } from "./consent-buttons";

export const metadata: Metadata = { title: "Allow an assistant" };

/** An assistant acts inside a workspace: a new member names theirs first, then comes back here. */
async function requireWorkspaces(query: Record<string, string | string[] | undefined>): Promise<MemberWorkspace[]> {
  const member = await currentMember();
  if (!member) redirect("/sign-in");
  const workspaces = await workspacesOf(db(), member.userId);
  if (workspaces.length > 0) return workspaces;
  const here = new URLSearchParams(Object.entries(query).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : [])));
  redirect(`/welcome?${new URLSearchParams({ next: `/consent?${here}` })}`);
}

const namedList = (names: string[]) => new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(names);

/** The assistant asking, by the name it registered with; a name it can't prove, so it is shown with its address. */
async function Request({ searchParams }: { searchParams: PageProps<"/consent">["searchParams"] }) {
  const query = await searchParams;
  const workspaces = await requireWorkspaces(query);
  const { client_id: clientId } = query;
  const client = typeof clientId === "string" ? await auth().api.getOAuthClientPublic({ query: { client_id: clientId }, headers: await headers() }).catch(() => null) : null;
  return (
    <Card className="mt-8 w-full max-w-md">
      <h1 className="text-xl font-bold tracking-[-0.025em]">
        {client?.client_name ?? "An assistant"} is asking for access to {BRAND}
      </h1>
      {client?.client_uri && <p className="mt-1 font-mono text-xs text-muted-foreground">{client.client_uri}</p>}
      <p className="mt-4 text-sm text-muted-foreground">
        It will be able to act on your behalf {workspaces.length > 1 ? `in all your workspaces, ${namedList(workspaces.map(({ name }) => name))}` : "in your workspace"}: read tickets, sort them, leave notes and draft replies. Replies wait for a member unless an owner or admin decides otherwise on the screen, and it can never change who belongs to a workspace.
      </p>
      <p className="mt-3 text-sm text-muted-foreground">It keeps this access until you disconnect it from the assistant, or leave the workspace.</p>
      <div className="mt-6">
        <ConsentButtons />
      </div>
    </Card>
  );
}

/** Where a member approves or refuses an assistant. */
export default function ConsentPage({ searchParams }: PageProps<"/consent">) {
  return (
    <Standalone>
      <Suspense fallback={<Loading />}>
        <Request searchParams={searchParams} />
      </Suspense>
    </Standalone>
  );
}
