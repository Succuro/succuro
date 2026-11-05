import type { Check } from "@/application/ports";
import { ProviderError } from "./http";

/**
 * Runs a connection's check: what the service refuses becomes the reason the member reads, and
 * anything else (no network, an unreadable answer) is said in plain words too, never as a raw error.
 */
export async function checked(provider: string, run: () => Promise<Check>): Promise<Check> {
  try {
    return await run();
  } catch (error) {
    return { ok: false, detail: error instanceof ProviderError ? error.message : `${provider} isn’t answering properly right now.` };
  }
}
