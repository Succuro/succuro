"use client";

import { useRef } from "react";
import { ActionForm } from "@/components/try-button";
import { FIELD, INLINE_FIELD, PrimaryButton, QuietButton } from "@/components/ui";
import type { Tried } from "@/domain/tried";

export interface SavedReplyChoice {
  id: string;
  title: string;
  body: string;
}

/** The reply box, with the saved replies that fill it. It starts from them; what leaves is what's in the box. */
export function ReplyBox({ action, savedReplies }: { action: (previous: Tried | null, form: FormData) => Promise<Tried>; savedReplies: SavedReplyChoice[] }) {
  const box = useRef<HTMLTextAreaElement>(null);
  return (
    <ActionForm action={action}>
      <textarea ref={box} name="body" required rows={6} aria-label="Your reply" placeholder="Write a reply to the requester" className={FIELD} />
      <div className="flex flex-wrap items-center gap-2">
        <PrimaryButton type="submit" name="intent" value="send">
          Send
        </PrimaryButton>
        <QuietButton type="submit" name="intent" value="resolve">
          Send and resolve
        </QuietButton>
        <QuietButton type="submit" name="intent" value="draft">
          Save as draft
        </QuietButton>
        {savedReplies.length > 0 && (
          <select
            aria-label="Insert a saved reply"
            defaultValue=""
            className={`${INLINE_FIELD} ml-auto`}
            onChange={(event) => {
              const chosen = savedReplies.find(({ id }) => id === event.currentTarget.value);
              if (chosen && box.current) box.current.value = chosen.body;
              event.currentTarget.value = "";
            }}
          >
            <option value="">Insert a saved reply</option>
            {savedReplies.map((reply) => (
              <option key={reply.id} value={reply.id}>
                {reply.title}
              </option>
            ))}
          </select>
        )}
      </div>
    </ActionForm>
  );
}
