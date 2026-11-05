import { receivePublicForm } from "@/application/public-form";
import { appServices } from "@/infrastructure/services";

/** Any website may post here: the product's public key says whose form it is, and carries no cookies or credentials. */
const OPEN_TO_ANY_SITE = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "86400" };

export function OPTIONS() {
  return new Response(null, { status: 204, headers: OPEN_TO_ANY_SITE });
}

/** What was posted, as JSON from the widget or as a plain HTML form's fields. */
async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.includes("application/json")) return request.json().catch(() => null);
  return Object.fromEntries((await request.formData().catch(() => new FormData())).entries());
}

/** Platforms put the visitor's address here; anywhere else this can be forged, and the limit per form still holds. */
const clientAddressOf = (request: Request) => request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

/** A request from a website's form or widget. */
export async function POST(request: Request) {
  const answer = await receivePublicForm(appServices(), await readBody(request), clientAddressOf(request));
  return Response.json("error" in answer ? { error: answer.error } : "number" in answer ? { received: true, number: answer.number } : { received: true }, { status: answer.status, headers: OPEN_TO_ANY_SITE });
}
