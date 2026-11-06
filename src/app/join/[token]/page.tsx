import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { invitationPath, seeInvitation } from "@/application/invitations";
import { Loading, Standalone } from "@/components/shell";
import { SignOutButton } from "@/components/sign-out-button";
import { Card, PrimaryButton } from "@/components/ui";
import { HOME } from "@/domain/safe-next";
import { INVITATION_REFUSALS, type InvitationRefusal } from "@/domain/team";
import { currentMember } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";
import { joinAction } from "./actions";

// The link is the invitation: it mustn't follow someone to the next site they visit.
export const metadata: Metadata = { title: "Join a workspace", robots: { index: false }, referrer: "no-referrer" };

/** Why this link doesn't let them in, naming nobody; with the wrong account, a way to change it and come back. */
function Refused({ refusal, back }: { refusal: InvitationRefusal; back: string }) {
  return (
    <Card className="mt-8 w-full max-w-md">
      <h1 className="text-xl font-bold tracking-[-0.025em]">This invitation doesn’t open a workspace for you</h1>
      <p className="mt-2 text-sm text-muted-foreground">{INVITATION_REFUSALS[refusal]}</p>
      <div className="mt-5 text-sm text-muted-foreground">
        {refusal === "other_address" ? (
          <SignOutButton to={`/sign-in?${new URLSearchParams({ next: back })}`} />
        ) : (
          <Link href={HOME} className="text-link hover:underline">
            Back to the start
          </Link>
        )}
      </div>
    </Card>
  );
}

/** Asks first rather than joining on opening the link: mail scanners open links too, and nothing changes on a GET. */
async function Invitation({ params }: Pick<PageProps<"/join/[token]">, "params">) {
  const { token } = await params;
  const back = invitationPath(token);
  const member = await currentMember();
  // Nobody signed in: no database read, and nothing said about the invitation until they are.
  if (!member) redirect(`/sign-in?${new URLSearchParams({ next: back })}`);
  const { db, now } = appServices();
  const seen = await seeInvitation(db, member.userId, token, now());
  if (seen.status !== "open") return <Refused refusal={seen.status} back={back} />;
  return (
    <Card className="mt-8 w-full max-w-md">
      <h1 className="text-xl font-bold tracking-[-0.025em]">Join {seen.workspaceName}</h1>
      <p className="mt-2 text-sm text-muted-foreground">You’ll see its tickets and its conversations, and your assistant will be able to work there with you.</p>
      <form action={joinAction.bind(null, token)} className="mt-5">
        <PrimaryButton type="submit">Join the workspace</PrimaryButton>
      </form>
    </Card>
  );
}

/** Where an invitation's link leads. */
export default function JoinPage({ params }: PageProps<"/join/[token]">) {
  return (
    <Standalone>
      <Suspense fallback={<Loading />}>
        <Invitation params={params} />
      </Suspense>
    </Standalone>
  );
}
