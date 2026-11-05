/**
 * Every service a workspace can connect, what each lets the app do, and how it is authorized. Pure
 * data: the screens list it, and each kind has one adapter in `infrastructure/connectors`.
 *
 * Secrets are always typed into the app's own connection page, never into a conversation: an
 * assistant's chat history is not a place for them.
 */

/** What a connection lets the app do; an adapter implements the matching port. */
export type Capability = "send_email" | "receive_email";

export interface Field {
  key: string;
  label: string;
  /** Sealed with the rest of the credentials, never shown again once saved. */
  secret: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
}

export interface Connector {
  kind: ConnectorKind;
  name: string;
  /** One line, for the catalogue. */
  summary: string;
  capabilities: readonly Capability[];
  fields: readonly Field[];
  /** Where its data is processed, for the workspace's GDPR register. */
  hosting: "EU" | "US" | "EU or US";
  /** The provider's page that explains where to find what the fields ask for. */
  docs?: string;
  /** What the service posts back once connected: the connection page shows the signed address to give it. */
  webhooks: string;
  /** The field that holds the signing secret: a provider only gives it once it knows the address, so it comes after connecting. */
  signingSecretField: string;
  /** What a member does in the service's own console, step by step. Consoles change: `docs` stays the reference. */
  setup: readonly string[];
}

export const CONNECTORS = [
  {
    kind: "resend",
    name: "Resend",
    summary: "Send replies from each product’s address, and receive the mail people send to it.",
    capabilities: ["send_email", "receive_email"],
    fields: [
      { key: "apiKey", label: "API key", secret: true, placeholder: "re_…", help: "With full access: reading a received mail takes more than a sending key can do." },
      { key: "webhookSecret", label: "Webhook signing secret", secret: true, optional: true, placeholder: "whsec_…", help: "Leave it empty the first time: Resend gives it once it knows the address shown after connecting." },
    ],
    hosting: "EU or US",
    docs: "https://resend.com/docs/dashboard/receiving/introduction",
    webhooks: "received mail and what became of each reply",
    signingSecretField: "webhookSecret",
    setup: [
      "In Resend, verify the domain of your support address, and turn on receiving for it so its mail reaches Resend.",
      "Create an API key with full access and connect it here.",
      "Under Webhooks, add the address shown after connecting, with the events email.received, email.sent, email.delivered, email.delivery_delayed, email.bounced, email.complained and email.failed.",
      "Paste the webhook’s signing secret back here. Until then, nothing posted to that address is believed.",
    ],
  },
] as const satisfies readonly (Omit<Connector, "kind"> & { kind: string })[];

export type ConnectorKind = (typeof CONNECTORS)[number]["kind"];

const byKind = new Map<string, Connector>(CONNECTORS.map((connector) => [connector.kind, connector as Connector]));

export function connectorOf(kind: string): Connector | undefined {
  return byKind.get(kind);
}

/** What was typed for a connector, or which required fields are missing. Empty optional fields stay out, so they don't overwrite what's saved. */
export function readFields(connector: Connector, values: Record<string, unknown>): { ok: true; values: Record<string, string> } | { ok: false; missing: string[] } {
  const read: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of connector.fields) {
    const value = typeof values[field.key] === "string" ? (values[field.key] as string).trim() : "";
    if (value) read[field.key] = value;
    else if (!field.optional) missing.push(field.label);
  }
  return missing.length ? { ok: false, missing } : { ok: true, values: read };
}
