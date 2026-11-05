import type { Metadata } from "next";
import { Suspense } from "react";
import { savedRepliesOf } from "@/application/saved-replies";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { ActionForm, ConfirmButton } from "@/components/try-button";
import { Card, FIELD, Labelled } from "@/components/ui";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { addSavedReplyAction, removeSavedReplyAction } from "./actions";

export const metadata: Metadata = { title: "Saved replies" };

async function Content() {
  const seat = await currentSeat();
  const replies = await savedRepliesOf(db(), seat.workspaceId);
  return (
    <div className="max-w-3xl space-y-4">
      {replies.map((reply) => (
        <Card key={reply.id}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium tracking-[-0.02em]">{reply.title}</h2>
            <ConfirmButton action={removeSavedReplyAction.bind(null, reply.id)} label="Remove" confirm="Confirm" />
          </div>
          <p className="mt-2 text-sm whitespace-pre-wrap text-muted-foreground">{reply.body}</p>
        </Card>
      ))}
      <Card>
        <h2 className="mb-4 font-semibold tracking-[-0.02em]">Add a saved reply</h2>
        <ActionForm action={addSavedReplyAction} submit="Save" busy="…">
          <Labelled label="Title">
            <input name="title" required maxLength={120} placeholder="Password reset" className={FIELD} />
          </Labelled>
          <Labelled label="Text">
            <textarea name="body" required rows={5} className={FIELD} />
          </Labelled>
        </ActionForm>
      </Card>
    </div>
  );
}

/** The answers the team keeps ready, for the reply box and for assistants. */
export default function SavedRepliesPage() {
  return (
    <Shell>
      <PageHeading title="Saved replies">The answers the team keeps ready, for the reply box and for assistants.</PageHeading>
      <SettingsNav />
      <Suspense fallback={<Loading />}>
        <Content />
      </Suspense>
    </Shell>
  );
}
