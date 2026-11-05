export interface FakeRoute {
  /** "POST https://api.resend.com/emails", or a prefix of a URL with its method. */
  match: string;
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

/**
 * A `fetch` that answers from canned routes (the first whose method and URL prefix match) and
 * records every call, so a test can check what an adapter sent. An unmatched call fails loudly.
 */
export function fakeFetch(routes: FakeRoute[]) {
  const calls: RecordedCall[] = [];
  const fetchFake = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : init.body ? String(init.body) : "";
    calls.push({ method, url, headers: new Headers(init.headers), body });
    const route = routes.find((candidate) => {
      const [routeMethod, routeUrl] = candidate.match.split(" ");
      return routeMethod === method && url.startsWith(routeUrl);
    });
    if (!route) throw new Error(`Unexpected ${method} ${url}`);
    const payload = route.text ?? (route.json === undefined ? "" : JSON.stringify(route.json));
    return new Response(payload, { status: route.status ?? 200, headers: { "content-type": route.text ? "text/plain" : "application/json", ...route.headers } });
  }) as typeof fetch;
  return { fetch: fetchFake, calls };
}
