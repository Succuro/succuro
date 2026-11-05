import { eq } from "drizzle-orm";
import { message, ticket } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { DeliveryOutcome, DeliveryReport } from "./ports";
import type { Services } from "./services";

/** How far along a reply is. Reports can arrive out of order, and a late "sent" must not undo "delivered". */
const PROGRESS: Record<string, number> = { sending: 0, sent: 1, delayed: 2, delivered: 3, bounced: 4, complained: 4, failed: 4 };

const FAILED_WORDS: Partial<Record<DeliveryOutcome, (detail: string | null) => string>> = {
  bounced: (detail) => `This reply bounced${detail ? `: ${detail}` : "."}`,
  complained: () => "The recipient marked this reply as spam.",
  failed: (detail) => `The mail service couldn’t send this reply${detail ? `: ${detail}` : "."}`,
};

/** Records what became of a reply. One that didn't reach them puts the ticket back with the team: nobody is really waiting on the requester. */
export async function recordDeliveryReport(services: Services, workspaceId: string, report: DeliveryReport): Promise<string> {
  return withWorkspace(services.db, workspaceId, async (tx) => {
    const [reply] = await tx.select().from(message).where(eq(message.providerId, report.providerId));
    if (!reply) return "ignored";
    const messageId = reply.emailMessageId ?? report.messageId;
    const moves = (PROGRESS[report.outcome] ?? 0) > (PROGRESS[reply.deliveryState ?? "sending"] ?? 0);
    const failure = FAILED_WORDS[report.outcome]?.(report.detail);
    await tx
      .update(message)
      .set({ emailMessageId: messageId, ...(moves ? { deliveryState: report.outcome, deliveryError: failure ?? null } : {}) })
      .where(eq(message.id, reply.id));
    if (moves && failure) {
      await tx.update(ticket).set({ status: "open", resolvedAt: null }).where(eq(ticket.id, reply.ticketId));
      await tx.insert(message).values({ ticketId: reply.ticketId, kind: "system", body: failure });
    }
    return "recorded";
  });
}
