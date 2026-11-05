import { describe, expect, it } from "vitest";
import { isAutomatedMail, messageIdsIn, parseAddress, replyAddress, replySubject, replyTokenFrom, replyTokenIn, senderHeader, senderLooksForged, threadOf, withoutPlus, withoutQuotedReply } from "@/domain/email";

describe("an address in a mail", () => {
  it.each([
    ["ada@acme.example", { address: "ada@acme.example", name: null }],
    ["Ada Martin <ADA@Acme.Example>", { address: "ada@acme.example", name: "Ada Martin" }],
    ['"Martin, Ada" <ada@acme.example>', { address: "ada@acme.example", name: "Martin, Ada" }],
  ])("reads %s", (value, parsed) => {
    expect(parseAddress(value)).toEqual(parsed);
  });

  it.each(["", "not an address", "<>", "a@b", "two words@acme.example"])("finds nothing in %j", (value) => {
    expect(parseAddress(value)).toBeNull();
  });

  it("drops what would break a header from a name", () => {
    expect(parseAddress("Ada\r\nBcc: x@y.example <ada@acme.example>")?.name).not.toMatch(/[\r\n]/);
  });
});

describe("the reply address", () => {
  const token = replyTokenFrom(new Uint8Array(20).fill(7));

  it("puts the token after a plus, in letters a mail server can't change the case of", () => {
    expect(token).toMatch(/^[a-z2-7]{20}$/);
    expect(replyAddress("support@acme.example", token)).toBe(`support+${token}@acme.example`);
  });

  it("is found again among where a mail was sent, whatever the capitals", () => {
    expect(replyTokenIn(["other@acme.example", `SUPPORT+${token.toUpperCase()}@acme.example`])).toBe(token);
  });

  it("isn't found in an ordinary plus address, or nowhere", () => {
    expect(replyTokenIn(["ada+newsletter@acme.example"])).toBeNull();
    expect(replyTokenIn([])).toBeNull();
  });

  it("comes off to name the product's own address", () => {
    expect(withoutPlus(`Support+${token}@acme.example`)).toBe("support@acme.example");
    expect(withoutPlus("support@acme.example")).toBe("support@acme.example");
  });
});

describe("a thread", () => {
  it("reads Message-IDs out of a header", () => {
    expect(messageIdsIn("<a@x> <b@y>\r\n <c@z>")).toEqual(["<a@x>", "<b@y>", "<c@z>"]);
    expect(messageIdsIn(null)).toEqual([]);
    expect(messageIdsIn("no ids here")).toEqual([]);
  });

  it("continues from the last one known, naming each once", () => {
    expect(threadOf(["<a@x>", null, "<b@y>", "<a@x>"])).toEqual({ inReplyTo: "<b@y>", references: ["<a@x>", "<b@y>"] });
    expect(threadOf([])).toEqual({ inReplyTo: undefined, references: [] });
  });

  it("marks a subject as a reply once", () => {
    expect(replySubject("Help")).toBe("Re: Help");
    expect(replySubject("Re: Help")).toBe("Re: Help");
    expect(replySubject("RE : Help")).toBe("RE : Help");
  });
});

describe("how a sender appears", () => {
  it("shows a name, or the address alone", () => {
    expect(senderHeader("Acme support", "support@acme.example")).toBe("Acme support <support@acme.example>");
    expect(senderHeader(null, "support@acme.example")).toBe("support@acme.example");
  });

  it("can't be made to forge a header", () => {
    expect(senderHeader('Evil"\r\nBcc: x@y.example', "support@acme.example")).toBe("Evil Bcc: x@y.example <support@acme.example>");
  });
});

describe("mail a machine wrote", () => {
  it.each([
    [{ "auto-submitted": "auto-replied" }],
    [{ "x-autoreply": "yes" }],
    [{ precedence: "bulk" }],
    [{ precedence: "auto_reply" }],
    [{ "list-id": "<news.acme.example>" }],
  ])("is recognised by %j", (headers) => {
    expect(isAutomatedMail(headers, "ada@customer.example")).toBe(true);
  });

  it("is recognised from a delivery robot", () => {
    expect(isAutomatedMail({}, "MAILER-DAEMON@mx.customer.example")).toBe(true);
  });

  it("isn't a person writing, even with the header set to no", () => {
    expect(isAutomatedMail({}, "ada@customer.example")).toBe(false);
    expect(isAutomatedMail({ "auto-submitted": "no" }, "ada@customer.example")).toBe(false);
  });
});

describe("a forged sender", () => {
  it("is suspected when the domain denies it, or when no proof holds", () => {
    expect(senderLooksForged({ dmarc: "fail" })).toBe(true);
    expect(senderLooksForged({ spf: "fail", dkim: "fail" })).toBe(true);
  });

  it("isn't when one proof holds, or when nothing was said", () => {
    expect(senderLooksForged({ spf: "fail", dkim: "pass", dmarc: "pass" })).toBe(false);
    expect(senderLooksForged({})).toBe(false);
  });
});

describe("what a mail client quotes back", () => {
  it("comes off an English or a French reply", () => {
    expect(withoutQuotedReply("Thanks!\n\nOn Tue, 3 Nov 2026 at 10:00, Support <s@acme.example> wrote:\n> Hello")).toBe("Thanks!");
    expect(withoutQuotedReply("Merci !\n\nLe mar. 3 nov. 2026 à 10:00, Support <s@acme.example> a écrit :\n> Bonjour")).toBe("Merci !");
  });

  it("comes off Outlook's block and quoted lines at the end", () => {
    expect(withoutQuotedReply("Thanks!\n\nFrom: Support <s@acme.example>\nSent: Tuesday\nTo: Ada\n\nHello")).toBe("Thanks!");
    expect(withoutQuotedReply("Thanks!\n> Hello\n> again\n")).toBe("Thanks!");
  });

  it("leaves everything when in doubt, or when nothing else would remain", () => {
    expect(withoutQuotedReply("Line one\n> a quote I answer below\nLine two")).toBe("Line one\n> a quote I answer below\nLine two");
    expect(withoutQuotedReply("> only a quote")).toBe("> only a quote");
  });
});
