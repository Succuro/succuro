/** How something a member asked for went, in their words: a refusal is an answer to show, not a failure. */
export type Tried = { ok: true; said: string } | { ok: false; error: string };
