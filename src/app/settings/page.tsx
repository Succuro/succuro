import type { Metadata } from "next";
import { Suspense } from "react";
import { noticePreferenceOf } from "@/application/notifications";
import { productsOf } from "@/application/products";
import { settingsOf } from "@/application/workspace-settings";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { ActionForm } from "@/components/try-button";
import { Card, Code } from "@/components/ui";
import { BRAND_SLUG } from "@/domain/brand";
import { managesSettings } from "@/domain/team";
import { mcpResource } from "@/infrastructure/auth/server";
import { currentSeat, type Seat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { env } from "@/infrastructure/env";
import { hasOwnMail } from "@/infrastructure/mail/own-mail";
import { saveAssistantSendingAction, saveNoticesAction } from "./actions";
import { TeamSection } from "./team-section";

export const metadata: Metadata = { title: "Settings" };

/** How each assistant adds a remote MCP server, in its own words. Their menus move: the address is what counts. */
const ASSISTANTS = [
  { name: "Claude", steps: "Settings → Connectors → Add a custom connector, then paste the address." },
  { name: "ChatGPT", steps: "Settings → Apps and connectors → Advanced settings: turn on developer mode, create a connector and paste the address. Depending on your plan, this may be limited to admins." },
];

/** Whether an assistant may send. On the screen only, for an owner or admin: no tool reaches this, because what customers write can carry instructions. */
async function AssistantSending({ seat }: { seat: Seat }) {
  const { assistantMaySend } = await settingsOf(db(), seat.workspaceId);
  const mayChange = managesSettings(seat.role);
  return (
    <Card>
      <h2 className="font-bold tracking-[-0.015em]">Who sends replies</h2>
      <p className="mt-1 text-sm text-muted-foreground">Only an owner or admin changes this, here. No assistant can.</p>
      <div className="mt-4">
        <ActionForm action={saveAssistantSendingAction} submit={mayChange ? "Save" : undefined} busy="…" className="flex flex-col gap-4">
          <fieldset disabled={!mayChange} className="space-y-2 text-sm">
            <legend className="sr-only">Who sends replies</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="assistantMaySend" value="no" defaultChecked={!assistantMaySend} className="mt-1" />
              <span>Approve first: an assistant only drafts, and a member sends from the ticket.</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="assistantMaySend" value="yes" defaultChecked={assistantMaySend} className="mt-1" />
              <span>An assistant may send a draft, once its member said yes in their conversation.</span>
            </label>
          </fieldset>
        </ActionForm>
      </div>
    </Card>
  );
}

/** What this member is mailed about. With no mail on the instance it says so plainly: the choice still saves, for when there is. */
async function Notifications({ seat }: { seat: Seat }) {
  const [preference, products] = await Promise.all([noticePreferenceOf(db(), seat.workspaceId, seat.userId), productsOf(db(), seat.workspaceId)]);
  const mailReady = hasOwnMail(env());
  return (
    <Card>
      <h2 className="font-bold tracking-[-0.015em]">Notifications</h2>
      <p className="mt-1 text-sm text-muted-foreground">Your own choice, in this workspace. You’re mailed when a ticket arrives or a requester answers, if the ticket is yours or nobody holds it, and never about your own words.</p>
      {!mailReady && <p className="mt-3 text-sm text-alert">This instance can’t send mail: its RESEND_API_KEY isn’t set, so nobody is told about tickets. They still arrive in the inbox.</p>}
      <div className="mt-4">
        <ActionForm action={saveNoticesAction} submit="Save notifications" busy="…" quiet className="flex flex-col gap-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="enabled" defaultChecked={preference.enabled} className="mt-1" />
            <span>Mail me about tickets</span>
          </label>
          {products.length > 0 && (
            <fieldset className="space-y-2 text-sm">
              <legend className="mb-2 text-muted-foreground">About these products</legend>
              {products.map((product) => (
                <label key={product.id} className="flex items-start gap-2">
                  <input type="checkbox" name="product" value={product.id} defaultChecked={!preference.mutedProductIds.includes(product.id)} className="mt-1" />
                  <span>{product.name}</span>
                </label>
              ))}
            </fieldset>
          )}
        </ActionForm>
      </div>
    </Card>
  );
}

function ConnectAnAssistant() {
  const address = mcpResource(env());
  return (
    <Card>
      <h2 className="font-bold tracking-[-0.015em]">Connect your assistant</h2>
      <p className="mt-2 text-sm text-muted-foreground">The address of this desk’s MCP server:</p>
      <div className="mt-3">
        <Code>{address}</Code>
      </div>
      <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
        {ASSISTANTS.map((assistant) => (
          <li key={assistant.name}>
            <span className="font-medium text-foreground">{assistant.name}.</span> {assistant.steps}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-muted-foreground">Claude Code:</p>
      <div className="mt-2">
        <Code>
          claude mcp add --transport http {BRAND_SLUG} {address}
        </Code>
      </div>
    </Card>
  );
}

async function Content() {
  const seat = await currentSeat();
  return (
    <div className="max-w-3xl space-y-4">
      <AssistantSending seat={seat} />
      <Notifications seat={seat} />
      <ConnectAnAssistant />
      <TeamSection seat={seat} />
    </div>
  );
}

/** Who may send, how to reach the desk from an assistant, and who works in it. */
export default function SettingsPage() {
  return (
    <Shell section="settings">
      <PageHeading title="Settings" />
      <SettingsNav current="/settings" />
      <Suspense fallback={<Loading />}>
        <Content />
      </Suspense>
    </Shell>
  );
}
