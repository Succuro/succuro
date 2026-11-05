// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WIDGET = readFileSync("public/widget.js", "utf8");

/** Loads the script as a page would, with these attributes on its tag. */
function load(attributes: Record<string, string>) {
  const script = document.createElement("script");
  script.src = "https://desk.acme.example/widget.js";
  for (const [name, value] of Object.entries(attributes)) script.dataset[name] = value;
  document.body.appendChild(script);
  Object.defineProperty(document, "currentScript", { value: script, configurable: true });
  new Function(WIDGET)();
  return document.body.lastElementChild?.shadowRoot as ShadowRoot;
}

const fill = (root: ShadowRoot, values: Record<string, string>) => {
  for (const [name, value] of Object.entries(values)) (root.querySelector(`[name="${name}"]`) as HTMLInputElement).value = value;
};

const submit = (root: ShadowRoot) => (root.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

describe("the widget", () => {
  const post = vi.fn();

  beforeEach(() => {
    document.body.innerHTML = "";
    post.mockReset();
    post.mockResolvedValue(new Response(JSON.stringify({ received: true, number: 1 }), { status: 201 }));
    vi.stubGlobal("fetch", post);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing without a key, and asks the server nothing as it loads", () => {
    load({});
    expect(document.body.querySelector("div")).toBeNull();
    load({ key: "pk_x" });
    expect(post).not.toHaveBeenCalled();
  });

  it("posts the form to the instance it was loaded from, with the page's context", async () => {
    const root = load({ key: "pk_test", title: "Acme" });
    Object.assign(window, { supportWidgetContext: { version: "1.2" } });
    fill(root, { name: "Ada Martin", email: "ada@customer.example", subject: "It broke", message: "Nothing works." });
    submit(root);
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    const [url, init] = post.mock.calls[0];
    expect(url).toBe("https://desk.acme.example/api/public/tickets");
    const body = JSON.parse(init.body);
    expect(body.context.page).not.toContain("?");
    expect(body).toMatchObject({ key: "pk_test", name: "Ada Martin", email: "ada@customer.example", subject: "It broke", message: "Nothing works.", website: "", context: { version: "1.2", page: expect.any(String) } });
    await vi.waitFor(() => expect(root.querySelector('[role="status"]')?.textContent).toContain("we got it"));
    Object.assign(window, { supportWidgetContext: undefined });
  });

  it("keeps a field for robots out of a person's way", () => {
    const root = load({ key: "pk_test" });
    const honeypot = root.querySelector('[name="website"]') as HTMLInputElement;
    expect(honeypot.tabIndex).toBe(-1);
    expect(honeypot.closest(".trap")?.getAttribute("aria-hidden")).toBe("true");
    expect(honeypot.required).toBe(false);
  });

  it("says what the server refused", async () => {
    post.mockResolvedValue(new Response(JSON.stringify({ error: "Too many requests from here: please try again in an hour." }), { status: 429 }));
    const root = load({ key: "pk_test" });
    fill(root, { email: "ada@customer.example", subject: "A", message: "B" });
    submit(root);
    await vi.waitFor(() => expect(root.querySelector('[role="status"]')?.textContent).toContain("Too many requests"));
  });

  it("can't be made to inject anything through its attributes", () => {
    const root = load({ key: "pk_test", title: "<img src=x onerror=alert(1)>", colour: "red;}body{display:none" });
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("h2")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(root.querySelector("style")?.textContent).not.toContain("body{");
  });

  it("opens and closes", () => {
    const root = load({ key: "pk_test" });
    const form = root.querySelector("form") as HTMLFormElement;
    const toggle = root.querySelector('button[type="button"]') as HTMLButtonElement;
    toggle.click();
    expect(form.classList.contains("open")).toBe(true);
    toggle.click();
    expect(form.classList.contains("open")).toBe(false);
  });
});
