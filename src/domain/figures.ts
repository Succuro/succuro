/**
 * The figures a dashboard reads: per product and per day, in UTC. Pure: the database hands over what
 * happened on the days something did, and this lays it out on every day of the period.
 */

export interface DayFigures {
  date: string;
  opened: number;
  resolved: number;
  /** Median, in seconds, over the tickets that got their first answer that day; null when none did. */
  firstResponseSeconds: number | null;
  /** Median, in seconds, over the tickets resolved that day; null when none were. */
  resolutionSeconds: number | null;
  /** Tickets still unresolved at the end of that day. A ticket reopened since counts as never resolved. */
  backlog: number;
}

export interface ProductFigures {
  /** Null for tickets that belong to no product. */
  slug: string | null;
  name: string;
  days: DayFigures[];
}

export interface HappenedOnADay {
  productId: string | null;
  date: string;
  count: number;
  seconds?: number | null;
}

const DAY_MS = 86_400_000;

export const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** Every day of a period that ends today and lasts this many days, oldest first. */
export function daysEndingAt(end: Date, days: number): string[] {
  return Array.from({ length: days }, (_, index) => dayOf(new Date(end.getTime() - (days - 1 - index) * DAY_MS)));
}

const onDay = (rows: readonly HappenedOnADay[], productId: string | null, date: string) => rows.find((row) => row.productId === productId && row.date === date);

export interface FiguresOfProduct {
  productId: string | null;
  opened: readonly HappenedOnADay[];
  resolved: readonly HappenedOnADay[];
  firstResponses: readonly HappenedOnADay[];
  /** How many were unresolved as the period began. */
  backlogBefore: number;
}

/** A product's days, its backlog carried from one to the next. */
export function daysOfProduct({ productId, opened, resolved, firstResponses, backlogBefore }: FiguresOfProduct, dates: readonly string[]): DayFigures[] {
  let backlog = backlogBefore;
  return dates.map((date) => {
    const openedThatDay = onDay(opened, productId, date)?.count ?? 0;
    const resolvedThatDay = onDay(resolved, productId, date);
    backlog += openedThatDay - (resolvedThatDay?.count ?? 0);
    return { date, opened: openedThatDay, resolved: resolvedThatDay?.count ?? 0, firstResponseSeconds: onDay(firstResponses, productId, date)?.seconds ?? null, resolutionSeconds: resolvedThatDay?.seconds ?? null, backlog };
  });
}
