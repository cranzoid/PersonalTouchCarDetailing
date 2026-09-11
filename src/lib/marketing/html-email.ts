import type { BusinessSettings } from "@/lib/settings";

/**
 * Pasted-HTML email campaigns.
 *
 * The owner designs a template elsewhere — Canva, Mailchimp, a designer — and
 * pastes the markup in. Everything here exists because that HTML is trusted to
 * be a *design* and nothing more: it is never executed in the admin (the
 * composer previews it inside a sandboxed iframe), it is checked for the
 * constructs that have no business in an email before it can be saved, and the
 * CASL footer is injected by us rather than left to the template author.
 */

type FooterSettings = Pick<
  BusinessSettings,
  "businessName" | "addressLine1" | "city" | "province" | "postalCode" | "phone" | "email"
>;

/** Escapes text interpolated into the footer markup we generate. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The same identity block and unsubscribe link the plain-text footer carries
 * (see compliance.ts), marked up for an HTML client. Inline styles only —
 * every serious email client drops a <style> block somewhere.
 */
export function emailComplianceFooterHtml(
  settings: FooterSettings,
  unsubscribeLink: string,
): string {
  const address = [
    settings.addressLine1,
    [settings.city, settings.province].filter(Boolean).join(", "),
    settings.postalCode,
  ]
    .filter((part) => part && part.trim().length > 0)
    .join(", ");
  const contact = [settings.phone, settings.email].filter(Boolean).join(" &middot; ");
  const cell = "font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#5A6B7D;";
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"',
    ' style="margin-top:24px;border-top:1px solid #DCE4EC;"><tr><td style="padding-top:16px;',
    cell,
    '">',
    `<div style="font-weight:bold;color:#0B2A4A;">${escapeHtml(settings.businessName)}</div>`,
    address ? `<div>${escapeHtml(address)}</div>` : "",
    contact ? `<div>${contact}</div>` : "",
    '<div style="margin-top:10px;">You are receiving this because you have booked with us.</div>',
    `<div style="margin-top:6px;"><a href="${escapeHtml(unsubscribeLink)}" style="color:#5A6B7D;">Unsubscribe</a></div>`,
    "</td></tr></table>",
  ].join("");
}

/**
 * Puts the footer inside the document body rather than after </html>, which
 * Gmail in particular will simply discard. Falls back to appending when the
 * paste is a fragment, which most pasted templates are.
 */
export function appendHtmlFooter(html: string, footer: string): string {
  const bodyClose = html.lastIndexOf("</body>");
  if (bodyClose !== -1) return html.slice(0, bodyClose) + footer + html.slice(bodyClose);
  const htmlClose = html.lastIndexOf("</html>");
  if (htmlClose !== -1) return html.slice(0, htmlClose) + footer + html.slice(htmlClose);
  return html + footer;
}

/**
 * A readable plain-text alternative derived from the HTML, used when the owner
 * has not written one. Not a full renderer — it keeps the words, the block
 * structure and the link targets, which is what the text part is for.
 */
export function htmlToPlainText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    // Keep the destination of a link: "Book now (https://…)" reads correctly in
    // a text client, where a bare anchor label would lose the URL entirely.
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
      const clean = String(label).replace(/<[^>]+>/g, "").trim();
      return clean && !clean.includes(href) ? `${clean} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li|table|section)>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "");

  text = decodeEntities(text);
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    middot: "·", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
    ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™",
  };
  return value.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1]?.toLowerCase() === "x"
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

export type HtmlIssue = { level: "error" | "warning"; message: string };

/**
 * Constructs that must not reach a saved campaign.
 *
 * These are REJECTED rather than stripped. Silently rewriting somebody's
 * template and then sending the result is worse than refusing it: the owner
 * would have approved a preview of something we then changed.
 */
const FORBIDDEN: { pattern: RegExp; message: string }[] = [
  { pattern: /<\s*script\b/i, message: "a <script> tag" },
  { pattern: /<\s*iframe\b/i, message: "an <iframe> tag" },
  { pattern: /<\s*(object|embed|applet)\b/i, message: "an <object>, <embed> or <applet> tag" },
  { pattern: /<\s*form\b/i, message: "a <form> tag" },
  { pattern: /\son[a-z]+\s*=/i, message: "an inline event handler such as onclick=" },
  { pattern: /javascript\s*:/i, message: "a javascript: link" },
  { pattern: /<\s*meta\b[^>]*http-equiv\s*=\s*["']?refresh/i, message: "a meta refresh redirect" },
];

export function checkCampaignHtml(html: string): HtmlIssue[] {
  const issues: HtmlIssue[] = [];
  const trimmed = html.trim();
  if (trimmed.length === 0) return issues;

  for (const { pattern, message } of FORBIDDEN) {
    if (pattern.test(trimmed)) {
      issues.push({
        level: "error",
        message: `The HTML contains ${message}. Email clients block these and some spam filters reject the whole message — remove it and paste again.`,
      });
    }
  }

  if (!/<[a-z][\s\S]*>/i.test(trimmed)) {
    issues.push({
      level: "warning",
      message: "This does not look like HTML — it will be sent as-is and may show the markup to the reader.",
    });
  }
  if (htmlToPlainText(trimmed).length === 0) {
    issues.push({
      level: "error",
      message: "The HTML has no readable text. An image-only email is usually filtered as spam.",
    });
  }
  // Gmail clips around 102KB and shows "[Message clipped]" with a link.
  if (trimmed.length > 100_000) {
    issues.push({
      level: "warning",
      message: "This template is over 100KB — Gmail will clip it and hide the end of the message.",
    });
  }
  return issues;
}
