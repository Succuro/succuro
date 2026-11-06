import { withoutSecrets } from "./without-secrets";

/**
 * Calls to providers' APIs, with their failures said in the member's words: a refused key, a
 * quota reached, a provider down. The provider's own message is kept, since it usually says
 * which field is wrong, without anything that reads like a credential.
 */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const WHY: Record<number, string> = {
  400: "refused the request",
  401: "refused the credentials",
  403: "refused access",
  404: "can’t find what was asked for",
  429: "is limiting requests: try again in a moment",
};

/** The provider's error message, wherever its API puts it. */
function messageIn(body: string): string | undefined {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const nested = json.error as { message?: unknown; text?: unknown } | undefined;
    const first = (json.errors as { message?: unknown }[] | undefined)?.[0];
    const candidate = json.message ?? json.error_description ?? nested?.message ?? nested?.text ?? first?.message ?? json.error ?? json.detail ?? json.title;
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return body.trim().slice(0, 200) || undefined;
  }
}

const SECRET_HEADER = /auth|key|token|secret/i;
const SHORTEST_SECRET = 8;

/** What this request carried that a service might quote back: its credentials, and what its address asks with. */
function secretsSent(url: string, init: RequestInit): string[] {
  const inHeaders = [...new Headers(init.headers)].filter(([name]) => SECRET_HEADER.test(name)).map(([, value]) => value.split(" ").at(-1) as string);
  const inAddress = URL.canParse(url) ? [...new URL(url).searchParams.values()] : [];
  return [...inHeaders, ...inAddress].filter((value) => value.length >= SHORTEST_SECRET);
}

/** Sends the request and reads the answer as text, for services that don't answer JSON; throws a ProviderError on anything but 2xx. */
export async function requestText(fetchUrl: typeof fetch, provider: string, url: string, init: RequestInit = {}): Promise<string> {
  const response = await fetchUrl(url, init);
  const body = await response.text();
  if (!response.ok) {
    const why = WHY[response.status] ?? (response.status >= 500 ? "isn’t answering properly right now" : `answered ${response.status}`);
    const detail = messageIn(body);
    throw new ProviderError(provider, response.status, `${provider} ${why}${detail ? `: ${withoutSecrets(detail, secretsSent(url, init))}` : "."}`);
  }
  return body;
}

/** Sends the request and reads the JSON answer; throws a ProviderError on anything but 2xx. */
export async function requestJson<T>(fetchUrl: typeof fetch, provider: string, url: string, init: RequestInit = {}): Promise<T> {
  const body = await requestText(fetchUrl, provider, url, init);
  return (body ? JSON.parse(body) : undefined) as T;
}

/** JSON request headers with a bearer token. */
export const bearerJson = (token: string): HeadersInit => ({ authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" });

