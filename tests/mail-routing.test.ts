import { describe, expect, it } from "vitest";
import { flaggedByMailService } from "@/domain/email";
import { addressRuleValue, decideNewMail, routeOf, type AddressRule } from "@/domain/mail-routing";

const rule = (value: string, productId = "one", screens = false): AddressRule => ({ productId, value, screens });

describe("what a member types as an address", () => {
  it.each([
    ["help@acme.example", "help@acme.example"],
    ["  HELP@Acme.Example ", "help@acme.example"],
    ["help+billing@acme.example", "help@acme.example"],
    ["acme.example", "acme.example"],
    ["@Acme.Example", "acme.example"],
    ["mail.acme.example", "mail.acme.example"],
  ])("keeps %s as %s", (typed, kept) => expect(addressRuleValue(typed)).toBe(kept));

  it.each(["", "   ", "acme", "not an address", "a@b", "Ada <ada@acme.example>", "acme..example", ".acme.example", `${"a".repeat(250)}.example`])("refuses %j", (typed) => expect(addressRuleValue(typed)).toBeNull());
});

describe("which rule a mail falls under", () => {
  it("finds an address, among other recipients, whatever its case or plus part", () => {
    const rules = [rule("help@acme.example")];
    expect(routeOf(["someone@elsewhere.example", "HELP+x@Acme.Example"], rules)?.value).toBe("help@acme.example");
  });

  it("finds a domain for any address on it, but not for another domain that ends the same way", () => {
    const rules = [rule("acme.example")];
    expect(routeOf(["anyone@acme.example"], rules)?.value).toBe("acme.example");
    expect(routeOf(["anyone@mail.acme.example"], rules)).toBeNull();
    expect(routeOf(["anyone@notacme.example"], rules)).toBeNull();
    expect(routeOf(["acme.example@elsewhere.example"], rules)).toBeNull();
  });

  it("puts an address before a domain, whatever the order of rules or recipients", () => {
    const rules = [rule("acme.example", "by-domain"), rule("help@other.example", "by-address")];
    expect(routeOf(["someone@acme.example", "help@other.example"], rules)?.productId).toBe("by-address");
  });

  it("prefers a rule that opens a ticket among equals, so a person's mail isn't held back by a copy elsewhere", () => {
    const rules = [rule("a@acme.example", "screened", true), rule("b@acme.example", "opens")];
    expect(routeOf(["a@acme.example", "b@acme.example"], rules)?.productId).toBe("opens");
  });

  it("finds nothing with no recipient or no rule", () => {
    expect(routeOf([], [rule("acme.example")])).toBeNull();
    expect(routeOf(["anyone@acme.example"], [])).toBeNull();
  });
});

describe("what a new mail comes to", () => {
  const signs = { route: rule("help@acme.example"), automated: false, flaggedByService: false, forged: false };

  it("opens a ticket for the product of its address, with nothing against it", () => {
    expect(decideNewMail(signs)).toEqual({ opens: true, productId: "one" });
  });

  it.each([
    ["no address of a product", { route: null }, "no_product"],
    ["an address set to screen first", { route: rule("help@acme.example", "one", true) }, "address_rule"],
    ["a machine", { automated: true }, "machine"],
    ["the service's verdict", { flaggedByService: true }, "service_flag"],
    ["failed sender checks", { forged: true }, "forged"],
    ["a verdict, whatever its address", { route: null, flaggedByService: true }, "service_flag"],
  ])("waits, for %s", (_, change, reason) => {
    expect(decideNewMail({ ...signs, ...change })).toEqual({ opens: false, reason });
  });
});

describe("the mail service's own verdict", () => {
  it("counts only a failure, on either header, whatever the case", () => {
    expect(flaggedByMailService({ "x-ses-spam-verdict": "FAIL" })).toBe(true);
    expect(flaggedByMailService({ "x-ses-virus-verdict": " fail " })).toBe(true);
    expect(flaggedByMailService({ "x-ses-spam-verdict": "PASS", "x-ses-virus-verdict": "GRAY" })).toBe(false);
    expect(flaggedByMailService({})).toBe(false);
  });
});
