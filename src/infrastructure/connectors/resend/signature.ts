import { createHmac } from "node:crypto";
import { sameSecret } from "../../crypto/secrets";

/**
 * Resend signs its webhooks with Svix's scheme (https://docs.svix.com/receiving/verifying-payloads/how-manual):
 * an HMAC-SHA256 of `id.timestamp.body` with the base64 part of the `whsec_` secret, sent as a
 * space-separated list of `v1,<base64>`. The raw body matters: parsing it first would change what was signed.
 */

/** Svix's own libraries allow five minutes each way. Its docs leave the value to the receiver. */
const TOLERANCE_SECONDS = 300;

export interface SignedRequest {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
}

function signatureOf(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`, "utf8").digest("base64");
}

/** Whether a request was signed with this secret, recently enough that it can't be an old one played again. */
export function signatureHolds(secret: string | undefined, { id, timestamp, signature, body }: SignedRequest, now: Date): boolean {
  if (!secret || !id || !timestamp || !signature) return false;
  const sent = Number(timestamp);
  if (!Number.isInteger(sent) || Math.abs(now.getTime() / 1000 - sent) > TOLERANCE_SECONDS) return false;
  const expected = signatureOf(secret, id, timestamp, body);
  return signature.split(" ").some((part) => part.startsWith("v1,") && sameSecret(part.slice(3), expected));
}
