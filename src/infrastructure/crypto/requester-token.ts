import { createHmac } from "node:crypto";
import { sameSecret } from "./secrets";

/**
 * The token of a requester's link: which ticket, in which workspace, until when, signed. Being signed
 * means a forged or mangled link is turned away without asking the database, and carrying its
 * workspace means the read that follows runs bound to it. It opens one ticket's conversation and nothing else.
 */

export interface RequesterClaims {
  workspaceId: string;
  ticketId: string;
  /** The ticket's link version when this was issued: raising it ends every link already sent. */
  version: number;
  expiresAt: Date;
}

export type RequesterTokenRead = { valid: true; claims: RequesterClaims } | { valid: false; why: "invalid" | "expired" };

/** Kept apart from anything else signed with the instance's secret: nothing signed for another purpose can pass as a link. */
const PURPOSE = "requester-link-v1";
const SIGNATURE_BYTES = 20;

const keyFrom = (secret: string) => createHmac("sha256", secret).update(PURPOSE).digest();
const signatureOf = (secret: string, payload: string) => createHmac("sha256", keyFrom(secret)).update(payload).digest().subarray(0, SIGNATURE_BYTES).toString("base64url");

const uuidBytes = (id: string) => Buffer.from(id.replaceAll("-", ""), "hex");
function uuidFrom(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

const PAYLOAD_BYTES = 16 + 16 + 4 + 4;

export function issueRequesterToken({ workspaceId, ticketId, version, expiresAt }: RequesterClaims, secret: string): string {
  const numbers = Buffer.alloc(8);
  numbers.writeUInt32BE(version, 0);
  numbers.writeUInt32BE(Math.floor(expiresAt.getTime() / 1000), 4);
  const payload = Buffer.concat([uuidBytes(workspaceId), uuidBytes(ticketId), numbers]).toString("base64url");
  return `${payload}.${signatureOf(secret, payload)}`;
}

export function readRequesterToken(token: string, secret: string, now: Date): RequesterTokenRead {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || !sameSecret(signature, signatureOf(secret, payload))) return { valid: false, why: "invalid" };
  const bytes = Buffer.from(payload, "base64url");
  if (bytes.length !== PAYLOAD_BYTES) return { valid: false, why: "invalid" };
  const expiresAt = new Date(bytes.readUInt32BE(36) * 1000);
  if (expiresAt <= now) return { valid: false, why: "expired" };
  return { valid: true, claims: { workspaceId: uuidFrom(bytes.subarray(0, 16)), ticketId: uuidFrom(bytes.subarray(16, 32)), version: bytes.readUInt32BE(32), expiresAt } };
}
