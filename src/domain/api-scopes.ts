/** What an API key may do. A dashboard's key can't open tickets, and an app's can't read the figures, unless a member says so. */
export const API_SCOPES = ["tickets:create", "figures:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_NAMES: Record<ApiScope, string> = { "tickets:create": "Open tickets", "figures:read": "Read figures" };

/** What a key made through an assistant gets: reading, and nothing else. What customers write can carry instructions, so a scope that changes something is given by a person, on the screen. */
export const READ_SCOPES = API_SCOPES.filter((scope) => scope.endsWith(":read"));

export const onlyScopes = (values: readonly unknown[]): ApiScope[] => API_SCOPES.filter((scope) => values.includes(scope));
