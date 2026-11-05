import { receiveHook } from "@/application/inbound-mail";
import { env } from "@/infrastructure/env";
import { appServices } from "@/infrastructure/services";

/** Where a connected service posts what happened: a mail that arrived, or what became of a reply. */
export async function POST(request: Request, { params }: RouteContext<"/api/hooks/[connectionId]">) {
  const { connectionId } = await params;
  // Not an id at all: refused without waking the database.
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return new Response(null, { status: 404 });
  const given = new URL(request.url);
  const url = new URL(given.pathname + given.search, env().BETTER_AUTH_URL).toString();
  const answer = await receiveHook(appServices(), connectionId, given.searchParams.get("token"), { method: request.method, url, headers: request.headers, body: await request.text() });
  return new Response(answer.body ?? null, { status: answer.status });
}
