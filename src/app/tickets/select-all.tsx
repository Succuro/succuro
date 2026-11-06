"use client";

/** Ticks every row of a list, or none: the only thing there that needs the browser. A row's box may sit outside the form and name it. */
export function SelectAll({ name = "ticket" }: { name?: string }) {
  return (
    <input
      type="checkbox"
      aria-label="Select all"
      onChange={(event) => {
        const { checked, form } = event.currentTarget;
        Array.from(form?.elements ?? []).forEach((element) => {
          if (element instanceof HTMLInputElement && element.name === name) element.checked = checked;
        });
      }}
    />
  );
}
