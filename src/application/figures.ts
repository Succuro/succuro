import { and, eq, gte, isNotNull, isNull, lt, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { daysEndingAt, daysOfProduct, type HappenedOnADay, type ProductFigures } from "@/domain/figures";
import type { Database } from "@/infrastructure/db/client";
import { product, ticket } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";

export interface SupportFigures {
  from: string;
  to: string;
  timezone: "UTC";
  products: ProductFigures[];
}

const dayIn = (column: SQLWrapper) => sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD')`;
const secondsBetween = (start: SQLWrapper, end: SQLWrapper) => sql<number | null>`round(percentile_cont(0.5) within group (order by extract(epoch from ${end} - ${start})))::integer`;

/** Tickets per product and per day of a timestamp, with their median time from `from` to it when one is asked for. */
function countByDay(tx: Database, at: typeof ticket.createdAt | typeof ticket.resolvedAt | typeof ticket.firstResponseAt, since: Date, productFilter: SQL | undefined, seconds = false): Promise<HappenedOnADay[]> {
  const date = dayIn(at);
  return tx
    .select({ productId: ticket.productId, date, count: sql<number>`count(*)::integer`, seconds: seconds ? secondsBetween(ticket.createdAt, at) : sql<null>`null` })
    .from(ticket)
    .where(and(isNotNull(at), gte(at, since), productFilter))
    .groupBy(ticket.productId, date);
}

/** A workspace's figures over the last days, UTC. No names, addresses or words: a dashboard's key gets nothing else. */
export async function figuresOf(db: Database, workspaceId: string, options: { days: number; productSlug?: string; now: Date }): Promise<SupportFigures> {
  const dates = daysEndingAt(options.now, options.days);
  const since = new Date(`${dates[0]}T00:00:00Z`);
  const products = await withWorkspace(db, workspaceId, async (tx) => {
    const known = await tx.select({ id: product.id, slug: product.slug, name: product.name }).from(product).orderBy(product.name);
    const chosen = options.productSlug ? known.filter(({ slug }) => slug === options.productSlug) : known;
    if (options.productSlug && chosen.length === 0) return [];
    const productFilter = options.productSlug ? eq(ticket.productId, chosen[0].id) : undefined;
    const opened = await countByDay(tx, ticket.createdAt, since, productFilter);
    const resolved = await countByDay(tx, ticket.resolvedAt, since, productFilter, true);
    const firstResponses = await countByDay(tx, ticket.firstResponseAt, since, productFilter, true);
    const before = await tx
      .select({ productId: ticket.productId, count: sql<number>`count(*)::integer` })
      .from(ticket)
      .where(and(lt(ticket.createdAt, since), or(isNull(ticket.resolvedAt), gte(ticket.resolvedAt, since)), productFilter))
      .groupBy(ticket.productId);
    const lines = [...chosen.map(({ id, slug, name }) => ({ id: id as string | null, slug: slug as string | null, name }))];
    const unfiled = [...opened, ...resolved, ...firstResponses, ...before].some(({ productId }) => productId === null);
    if (!options.productSlug && unfiled) lines.push({ id: null, slug: null, name: "No product" });
    return lines.map(({ id, slug, name }) => ({ slug, name, days: daysOfProduct({ productId: id, opened, resolved, firstResponses, backlogBefore: before.find(({ productId }) => productId === id)?.count ?? 0 }, dates) }));
  });
  return { from: dates[0], to: dates.at(-1) as string, timezone: "UTC", products };
}
