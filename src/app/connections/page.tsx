import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connectionsOf, connectorsOffered } from "@/application/connections";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { StatusDot } from "@/components/ui";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

export const metadata: Metadata = { title: "Connections" };

async function Catalogue() {
  const seat = await currentSeat();
  const connections = await connectionsOf(appServices(), seat.workspaceId);
  return (
    <ul className="grid max-w-3xl gap-3 sm:grid-cols-2">
      {connectorsOffered().map((connector) => {
        const mine = connections.filter((connection) => connection.kind === connector.kind);
        return (
          <li key={connector.kind}>
            <Link href={`/connections/${connector.kind}`} className="card-sheen flex h-full flex-col rounded-2xl border bg-card p-5 transition-colors hover:border-foreground/20">
              <span className="flex items-center gap-2 font-medium tracking-[-0.02em]">
                {mine.length > 0 && <StatusDot status={mine.some((connection) => connection.status === "failing") ? "failing" : "connected"} />}
                {connector.name}
              </span>
              <span className="mt-2 flex-1 text-sm text-muted-foreground">{connector.summary}</span>
              {mine.some((connection) => connection.lastError) && <span className="mt-3 text-xs text-alert">{mine.find((connection) => connection.lastError)?.lastError}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** The services a workspace can connect. */
export default function ConnectionsPage() {
  return (
    <Shell>
      <PageHeading title="Connections">What the desk sends and receives mail through. Keys are typed here, never in a conversation, and stay sealed.</PageHeading>
      <SettingsNav />
      <Suspense fallback={<Loading />}>
        <Catalogue />
      </Suspense>
    </Shell>
  );
}
