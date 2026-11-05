import { desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Requester } from "@/domain/ticket-input";
import type { Database } from "@/infrastructure/db/client";
import { contact, ticket } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";

/**
 * Someone who wrote in, made the first time they do. What's known isn't overwritten by what comes
 * next: anyone can put any name on an email or a form, and the first name a member saw stays. An app
 * holding a key knows its own user, so its external id does update.
 */
export async function contactFor(tx: Database, requester: Requester) {
  const [row] = await tx
    .insert(contact)
    .values({ email: requester.email, name: requester.name ?? null, externalId: requester.externalId ?? null })
    .onConflictDoUpdate({ target: [contact.workspaceId, contact.email], set: { name: sql`coalesce(${contact.name}, excluded.name)`, externalId: sql`coalesce(excluded.external_id, ${contact.externalId})` } })
    .returning();
  return row;
}

/** A LIKE pattern for what someone typed: % and _ in it are meant literally. */
export const containing = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

/** People by address, name or external id, with their latest tickets. */
export async function findContacts(db: Database, workspaceId: string, query: string) {
  const pattern = containing(query.trim());
  return withWorkspace(db, workspaceId, async (tx) => {
    const people = await tx
      .select()
      .from(contact)
      .where(or(ilike(contact.email, pattern), ilike(contact.name, pattern), eq(contact.externalId, query.trim())))
      .limit(20);
    return Promise.all(
      people.map(async ({ id, email, name, externalId }) => ({
        id,
        email,
        name,
        externalId,
        tickets: await tx.select({ number: ticket.number, subject: ticket.subject, status: ticket.status, lastMessageAt: ticket.lastMessageAt }).from(ticket).where(eq(ticket.contactId, id)).orderBy(desc(ticket.lastMessageAt)).limit(20),
      })),
    );
  });
}
