import { describe, expect, it } from "vitest";
import {
  appendHtmlFooter,
  checkCampaignHtml,
  emailComplianceFooterHtml,
  escapeHtml,
  htmlToPlainText,
} from "../src/lib/marketing/html-email";

const settings = {
  businessName: "Personal Touch Car Detailing",
  addressLine1: "123 King St E",
  city: "Hamilton",
  province: "ON",
  postalCode: "L8N 1A1",
  phone: "905-555-0100",
  email: "hello@ptcd.ca",
};

describe("checkCampaignHtml", () => {
  it("accepts an ordinary pasted template", () => {
    const html = '<table><tr><td><h1>Come back</h1><p>We miss you.</p></td></tr></table>';
    expect(checkCampaignHtml(html)).toEqual([]);
  });

  it("keeps <style>, which real email templates need", () => {
    const html = "<style>.btn{color:#fff}</style><div class='btn'>Book now</div>";
    expect(checkCampaignHtml(html).filter((i) => i.level === "error")).toEqual([]);
  });

  for (const [name, html] of [
    ["script tags", "<div>Hi</div><script>alert(1)</script>"],
    ["iframes", "<iframe src='https://evil.example'></iframe><p>Hi</p>"],
    ["inline event handlers", `<p onclick="steal()">Hi</p>`],
    ["javascript: links", `<a href="javascript:alert(1)">Book</a>`],
    ["forms", "<form action='/x'><input name='card'></form><p>Hi</p>"],
    ["meta refresh", `<meta http-equiv="refresh" content="0;url=https://evil.example"><p>Hi</p>`],
  ] as const) {
    it(`rejects ${name}`, () => {
      const errors = checkCampaignHtml(html).filter((i) => i.level === "error");
      expect(errors.length).toBeGreaterThan(0);
    });
  }

  it("rejects a template with no readable words", () => {
    const errors = checkCampaignHtml('<img src="https://x/a.png">').filter((i) => i.level === "error");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("says nothing about an empty box — that is the plain-text case", () => {
    expect(checkCampaignHtml("   ")).toEqual([]);
  });
});

describe("htmlToPlainText", () => {
  it("keeps the words and drops the markup", () => {
    expect(htmlToPlainText("<h1>Come back</h1><p>We <b>miss</b> you.</p>")).toBe(
      "Come back\n\nWe miss you.",
    );
  });

  it("keeps a link's destination, which a text reader cannot otherwise reach", () => {
    expect(htmlToPlainText('<a href="https://ptcd.ca/book">Book now</a>')).toBe(
      "Book now (https://ptcd.ca/book)",
    );
  });

  it("does not repeat a url that is already its own label", () => {
    expect(htmlToPlainText('<a href="https://ptcd.ca/book">https://ptcd.ca/book</a>')).toBe(
      "https://ptcd.ca/book",
    );
  });

  it("drops style and script content rather than printing it as words", () => {
    expect(htmlToPlainText("<style>.a{color:red}</style><p>Hi</p>")).toBe("Hi");
  });

  it("decodes entities so the reader sees characters, not codes", () => {
    expect(htmlToPlainText("<p>Tom &amp; Jerry &mdash; 50&#37; off</p>")).toBe("Tom & Jerry — 50% off");
  });

  it("collapses the blank space a table layout leaves behind", () => {
    expect(htmlToPlainText("<table><tr><td>A</td></tr><tr><td>B</td></tr></table>")).toBe("A\n\nB");
  });
});

describe("emailComplianceFooterHtml", () => {
  it("carries the sender identity and a working unsubscribe link", () => {
    const footer = emailComplianceFooterHtml(settings, "https://ptcd.ca/unsubscribe/tok");
    expect(footer).toContain("Personal Touch Car Detailing");
    expect(footer).toContain("123 King St E, Hamilton, ON, L8N 1A1");
    expect(footer).toContain('href="https://ptcd.ca/unsubscribe/tok"');
  });

  it("escapes a business name that contains markup", () => {
    const footer = emailComplianceFooterHtml(
      { ...settings, businessName: 'A&B <script>' },
      "https://ptcd.ca/u/1",
    );
    expect(footer).not.toContain("<script>");
    expect(footer).toContain("A&amp;B");
  });
});

describe("appendHtmlFooter", () => {
  it("puts the footer inside <body>, which Gmail keeps", () => {
    const out = appendHtmlFooter("<html><body><p>Hi</p></body></html>", "<i>F</i>");
    expect(out).toBe("<html><body><p>Hi</p><i>F</i></body></html>");
  });

  it("falls back to inside </html> when there is no body tag", () => {
    expect(appendHtmlFooter("<html><p>Hi</p></html>", "<i>F</i>")).toBe("<html><p>Hi</p><i>F</i></html>");
  });

  it("appends to a bare fragment, which is what most pastes are", () => {
    expect(appendHtmlFooter("<p>Hi</p>", "<i>F</i>")).toBe("<p>Hi</p><i>F</i>");
  });
});

describe("escapeHtml", () => {
  it("neutralises every character that could close a tag or attribute", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;",
    );
  });
});
