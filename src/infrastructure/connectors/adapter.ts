import type { ConnectorClient, EmailSender, MailEventReader } from "@/application/ports";

/**
 * What an adapter is given to talk to its service: the connection's fields as the member typed them,
 * the address the service posts its webhooks to, and `fetch` and the clock, both replaceable in tests.
 */
export interface AdapterContext {
  fields: Readonly<Record<string, string>>;
  hookUrl: string;
  fetch: typeof fetch;
  now: () => Date;
}

/** An adapter's client: the check every connection has, and the ports of its connector's capabilities. */
export type AdapterClient = ConnectorClient & Partial<EmailSender & MailEventReader>;

export type Adapter = (context: AdapterContext) => AdapterClient;
