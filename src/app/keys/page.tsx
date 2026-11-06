import type { Metadata } from "next";
import { Suspense } from "react";
import { apiKeysOf } from "@/application/api-keys";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { Card, Code, EmptyState, QuietButton } from "@/components/ui";
import { when } from "@/components/when";
import { SCOPE_NAMES, type ApiScope } from "@/domain/api-scopes";
import { managesSettings } from "@/domain/team";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { env } from "@/infrastructure/env";
import { revokeKeyAction } from "./actions";
import { NewKeyForm } from "./new-key-form";

export const metadata: Metadata = { title: "API keys" };

async function Keys() {
  const seat = await currentSeat();
  const keys = await apiKeysOf(db(), seat.workspaceId);
  const mayChange = managesSettings(seat.role);
  const base = env().BETTER_AUTH_URL;
  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        {mayChange ? <NewKeyForm /> : <p className="text-sm text-muted-foreground">Only owners and admins make keys.</p>}
        <p className="mt-5 text-sm text-muted-foreground">Open a ticket from an app:</p>
        <div className="mt-2">
          <Code>POST {new URL("/api/v1/tickets", base).toString()}</Code>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">Read the figures, with no names or addresses in them:</p>
        <div className="mt-2">
          <Code>GET {new URL("/api/v1/figures?days=30", base).toString()}</Code>
        </div>
      </Card>
      {keys.length === 0 && <EmptyState title="No key yet">A key lets one app open tickets or read figures, and nothing else.</EmptyState>}
      {keys.length > 0 && (
        <ul className="divide-y rounded-2xl border bg-card">
          {keys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 text-sm">
              <span className="font-medium">{key.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{key.prefix}…</span>
              <span className="text-xs text-muted-foreground">{key.scopes.map((scope) => SCOPE_NAMES[scope as ApiScope] ?? scope).join(", ")}</span>
              <span className="ml-auto text-xs text-muted-foreground">{key.lastUsedAt ? `Used ${when(key.lastUsedAt)}` : "Never used"}</span>
              {mayChange && (
                <form action={revokeKeyAction.bind(null, key.id)}>
                  <QuietButton type="submit">Revoke</QuietButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Keys other apps reach the workspace with: to open tickets, to read figures, or both. */
export default function KeysPage() {
  return (
    <Shell section="settings">
      <PageHeading title="API keys">For your apps to open tickets and your dashboards to read figures. Each key does only what it was given, and stops working when whoever made it leaves the workspace.</PageHeading>
      <SettingsNav current="/keys" />
      <Suspense fallback={<Loading />}>
        <Keys />
      </Suspense>
    </Shell>
  );
}
