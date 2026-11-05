"use client";

import { useState } from "react";
import { PrimaryButton, QuietButton } from "@/components/ui";
import { authClient } from "@/infrastructure/auth/client";

/** The member's answer: Better Auth then sends the assistant back with a code, or with a refusal. */
export function ConsentButtons() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function answer(accept: boolean) {
    setBusy(true);
    const { data, error: failed } = await authClient.oauth2.consent({ accept });
    if (failed) {
      setError(failed.message ?? "That answer didn’t go through.");
      setBusy(false);
      return;
    }
    const target = (data as { url?: string; redirect_uri?: string } | null)?.url ?? (data as { redirect_uri?: string } | null)?.redirect_uri;
    if (target) window.location.assign(target);
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <PrimaryButton disabled={busy} onClick={() => answer(true)}>
        Allow
      </PrimaryButton>
      <QuietButton disabled={busy} onClick={() => answer(false)}>
        Refuse
      </QuietButton>
      {error && <p className="w-full text-sm text-alert">{error}</p>}
    </div>
  );
}
