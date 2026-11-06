import { parseAddress, withoutPlus } from "./email";

/**
 * Which new mail opens a ticket, and which waits for a member instead. Pure: the use case reads the
 * rules and stores the mail. Everything here takes what a stranger's mail says, so a mail can only
 * end up waiting or opening a ticket, never anything else.
 */

/** Something a product receives on: one address, or a domain for every address on it. */
export interface AddressRule {
  productId: string;
  value: string;
  /** New mail here waits in Screened, with this product already chosen. */
  screens: boolean;
}

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const LONGEST_ADDRESS = 254;

/** What a member typed, in the one form it's kept: null when it's neither an address nor a domain. */
export function addressRuleValue(typed: string): string | null {
  const value = typed.trim().toLowerCase().replace(/^@/, "");
  if (value.length > LONGEST_ADDRESS) return null;
  if (!value.includes("@")) return DOMAIN.test(value) ? value : null;
  const parsed = parseAddress(value);
  return parsed && parsed.name === null ? withoutPlus(parsed.address) : null;
}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

/** Among rules that match equally well, one that opens a ticket: a person wrote to an address that's answered. */
const preferred = (rules: AddressRule[]): AddressRule | undefined => rules.find(({ screens }) => !screens) ?? rules[0];

/** The rule a mail falls under: an address before a domain, whatever else it was sent to. */
export function routeOf(addressedTo: readonly string[], rules: readonly AddressRule[]): AddressRule | null {
  const addresses = new Set(addressedTo.map(withoutPlus));
  const domains = new Set([...addresses].map(domainOf));
  return preferred(rules.filter(({ value }) => addresses.has(value))) ?? preferred(rules.filter(({ value }) => domains.has(value))) ?? null;
}

export const SCREEN_REASONS = ["no_product", "address_rule", "machine", "service_flag", "forged", "own_address", "no_sender"] as const;
export type ScreenReason = (typeof SCREEN_REASONS)[number];

export const SCREEN_REASON_NAMES: Record<ScreenReason, string> = {
  no_product: "Sent to no product’s address",
  address_rule: "Its address is screened first",
  machine: "A machine sent it",
  service_flag: "The mail service flagged it",
  forged: "It failed its sender checks",
  own_address: "It came from one of your own addresses",
  no_sender: "It has no sender address",
};

export interface NewMailSigns {
  route: AddressRule | null;
  automated: boolean;
  flaggedByService: boolean;
  forged: boolean;
}

export type NewMailDecision = { opens: true; productId: string } | { opens: false; reason: ScreenReason };

/** Whether a new mail opens a ticket, or why it waits. What the mail itself gives away comes before where it was sent. */
export function decideNewMail({ route, automated, flaggedByService, forged }: NewMailSigns): NewMailDecision {
  if (automated) return { opens: false, reason: "machine" };
  if (flaggedByService) return { opens: false, reason: "service_flag" };
  if (forged) return { opens: false, reason: "forged" };
  if (!route) return { opens: false, reason: "no_product" };
  return route.screens ? { opens: false, reason: "address_rule" } : { opens: true, productId: route.productId };
}
