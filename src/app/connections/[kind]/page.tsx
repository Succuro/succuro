import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connectionsOf, type ConnectionView } from "@/application/connections";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { ActionForm, ConfirmButton, TryButton } from "@/components/try-button";
import { Card, Code, FIELD, StatusDot } from "@/components/ui";
import { when } from "@/components/when";
import { CONNECTORS, connectorOf, type Connector } from "@/domain/connectors";
import { managesSettings } from "@/domain/team";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";
import { checkAction, disconnectAction, saveSigningSecretAction } from "../actions";
import { ConnectForm } from "./connect-form";

export function generateStaticParams() {
  return CONNECTORS.map((connector) => ({ kind: connector.kind }));
}

export async function generateMetadata({ params }: PageProps<"/connections/[kind]">): Promise<Metadata> {
  const { kind } = await params;
  return { title: connectorOf(kind)?.name ?? "Connection" };
}

/** Where the service posts back, and the secret that proves it was the service. */
function Webhook({ connection, connector, mayChange }: { connection: ConnectionView; connector: Connector; mayChange: boolean }) {
  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm text-muted-foreground">
        {connector.name} posts {connector.webhooks} to this address:
      </p>
      <Code>{connection.hookUrl}</Code>
      {connection.signingSecretSaved ? <p className="text-sm text-calm">Its signing secret is saved.</p> : <p className="text-sm text-alert">No signing secret yet: nothing posted to this address is believed until you paste it.</p>}
      {mayChange && (
        <ActionForm action={saveSigningSecretAction.bind(null, connector.kind, connection.id)} submit={connection.signingSecretSaved ? "Replace the signing secret" : "Save the signing secret"} busy="…" quiet>
          <input name="secret" type="password" required autoComplete="off" placeholder="whsec_…" aria-label="Webhook signing secret" className={`${FIELD} font-mono text-xs`} />
        </ActionForm>
      )}
    </div>
  );
}

function Connection({ connection, connector, mayChange }: { connection: ConnectionView; connector: Connector; mayChange: boolean }) {
  return (
    <Card>
      <div className="flex min-w-0 items-center gap-3">
        <StatusDot status={connection.status} />
        <span className="min-w-0 flex-1 truncate font-medium">{connection.label}</span>
      </div>
      {connection.checkedAt && <p className="mt-1 text-xs text-muted-foreground">Checked {when(connection.checkedAt)}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <TryButton action={checkAction.bind(null, connector.kind, connection.id)} label="Check" busy="Checking…" />
        {mayChange && <ConfirmButton action={disconnectAction.bind(null, connector.kind, connection.id)} label="Disconnect" confirm="Confirm: forget this account and its keys" />}
      </div>
      {connection.lastError && <p className="mt-3 text-sm text-alert">{connection.lastError}</p>}
      <Webhook connection={connection} connector={connector} mayChange={mayChange} />
    </Card>
  );
}

const HOSTING_WORDS = { EU: "the European Union", US: "the United States", "EU or US": "the European Union or the United States, depending on your account" };

async function Content({ params }: Pick<PageProps<"/connections/[kind]">, "params">) {
  const { kind } = await params;
  const connector = connectorOf(kind);
  if (!connector) notFound();
  const seat = await currentSeat();
  const mine = (await connectionsOf(appServices(), seat.workspaceId)).filter((connection) => connection.kind === connector.kind);
  const mayChange = managesSettings(seat.role);
  return (
    <>
      <PageHeading title={connector.name}>{connector.summary}</PageHeading>
      <SettingsNav current="/connections" />
      <div className="max-w-3xl space-y-4">
        {mine.map((connection) => (
          <Connection key={connection.id} connection={connection} connector={connector} mayChange={mayChange} />
        ))}
        <Card>
          <h2 className="mb-4 font-bold tracking-[-0.015em]">{mine.length > 0 ? "Connect again, with a new key" : "Connect"}</h2>
          <ol className="mb-5 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            {connector.setup.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {mayChange ? <ConnectForm kind={connector.kind} fields={connector.fields} /> : <p className="text-sm text-muted-foreground">Only owners and admins connect services.</p>}
          <p className="mt-5 text-xs text-muted-foreground">
            Data processed in {HOSTING_WORDS[connector.hosting]}.{" "}
            {connector.docs && (
              <a href={connector.docs} target="_blank" rel="noreferrer" className="text-link hover:underline">
                The service’s documentation
              </a>
            )}
          </p>
        </Card>
      </div>
    </>
  );
}

/** One service: the account connected, and how to connect it. */
export default function ConnectionPage({ params }: PageProps<"/connections/[kind]">) {
  return (
    <Shell section="settings">
      <Suspense fallback={<Loading />}>
        <Content params={params} />
      </Suspense>
    </Shell>
  );
}
