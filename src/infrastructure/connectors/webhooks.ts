import { ProviderError } from "./http";

/** What adapters need to trust and read what a service posts here. */

export const forgedWebhook = (provider: string) => new ProviderError(provider, 401, `Not read: nothing proves this was sent by ${provider}.`);

/** The JSON a service posted; throws when it can't be read, so the service knows to send it again. */
export function parseWebhook<T extends object>(provider: string, body: string): T {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) return parsed as T;
  } catch {
    // Said below, as for JSON that isn't an object.
  }
  throw new ProviderError(provider, 400, `${provider} sent a message that can’t be read.`);
}
