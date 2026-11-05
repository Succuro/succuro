"use client";

import { useActionState } from "react";
import { Code, FIELD, PrimaryButton } from "@/components/ui";
import { API_SCOPES, SCOPE_NAMES } from "@/domain/api-scopes";
import { createKeyAction, type NewKeyState } from "./actions";

/** Names a key, says what it may do, and shows it, this once. */
export function NewKeyForm() {
  const [state, submit, pending] = useActionState<NewKeyState, FormData>(createKeyAction, {});
  return (
    <form action={submit} className="flex flex-col gap-3">
      <input name="name" required maxLength={80} placeholder="Billing app" aria-label="Key name" className={FIELD} />
      <fieldset className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <legend className="sr-only">What this key may do</legend>
        {API_SCOPES.map((scope) => (
          <label key={scope} className="flex items-center gap-2">
            <input type="checkbox" name="scope" value={scope} />
            {SCOPE_NAMES[scope]}
          </label>
        ))}
      </fieldset>
      <div>
        <PrimaryButton type="submit" disabled={pending}>
          Create a key
        </PrimaryButton>
      </div>
      {state.error && <p className="text-sm text-alert">{state.error}</p>}
      {state.key && (
        <div>
          <p className="mb-2 text-sm text-muted-foreground">Copy it now: it won’t show again.</p>
          <Code>{state.key}</Code>
        </div>
      )}
    </form>
  );
}
