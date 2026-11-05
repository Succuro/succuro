import { accessOfKey, bearerOf } from "@/application/api-keys";
import { figuresOf } from "@/application/figures";
import { appServices } from "@/infrastructure/services";

const LONGEST_PERIOD_DAYS = 365;

/** A workspace's figures, for a dashboard holding one of its keys. Shape documented in docs/00-product.md. */
export async function GET(request: Request) {
  // The header first: a build prerenders this route, and has no environment to read for what follows.
  const key = bearerOf(request);
  const services = appServices();
  const access = await accessOfKey(services.db, key, "figures:read");
  if (access.status === "unknown") return Response.json({ error: "Missing or refused API key." }, { status: 401 });
  if (access.status === "forbidden") return Response.json({ error: "This key may not read figures." }, { status: 403 });
  const query = new URL(request.url).searchParams;
  const days = Math.min(Math.max(Math.trunc(Number(query.get("days"))) || 30, 1), LONGEST_PERIOD_DAYS);
  return Response.json(await figuresOf(services.db, access.workspaceId, { days, productSlug: query.get("product") ?? undefined, now: services.now() }));
}
