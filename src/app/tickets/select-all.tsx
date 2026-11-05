"use client";

/** Ticks every row of the inbox's list, or none: the only thing there that needs the browser. */
export function SelectAll() {
  return (
    <input
      type="checkbox"
      aria-label="Select all"
      onChange={(event) => {
        const rows = event.currentTarget.form?.querySelectorAll<HTMLInputElement>('input[name="ticket"]') ?? [];
        rows.forEach((row) => {
          row.checked = event.currentTarget.checked;
        });
      }}
    />
  );
}
