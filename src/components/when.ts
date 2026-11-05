const dated = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const dayOnly = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" });

/** A moment as every screen shows it: one zone for everyone, and it says which. */
export const when = (at: Date) => `${dated.format(at)} UTC`;

export const dayOf = (at: Date) => dayOnly.format(at);
