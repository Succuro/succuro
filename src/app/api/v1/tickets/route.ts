import { accessOfKey, bearerOf, waitForKey } from "@/application/api-keys";
import { createTicket } from "@/application/tickets";
import { firstProblem, newTicketInput } from "@/domain/ticket-input";
import { appServices } from "@/infrastructure/services";

const REFUSED = { error: "Missing or refused API key." };

/** A ticket from an app holding a key, with what it knows about the request: what it's about and where it happened. */
export async function POST(request: Request) {
  const services = appServices();
  const access = await accessOfKey(services.db, bearerOf(request), "tickets:create");
  if (access.status === "unknown") return Response.json(REFUSED, { status: 401 });
  if (access.status === "forbidden") return Response.json({ error: "This key may not open tickets." }, { status: 403 });
  const wait = await waitForKey(services.db, access.workspaceId, access.keyId, services.now());
  if (wait !== null) return Response.json({ error: "This key has opened too many tickets this hour." }, { status: 429, headers: { "Retry-After": String(wait) } });
  const parsed = newTicketInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: firstProblem(parsed.error) }, { status: 400 });
  const created = await createTicket(services, access.workspaceId, parsed.data, { channel: "api" });
  if (!created.ok) return Response.json({ error: created.error }, { status: 422 });
  return Response.json({ id: created.id, number: created.number, status: created.status, requesterUrl: created.requesterUrl }, { status: 201 });
}
