import { convert } from "html-to-text";
import { simpleParser } from "mailparser";

export interface RenderedEmailAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
  size: number;
  inline: boolean;
}

export function extractReadableEmailText(input: { textBody?: string; htmlBody?: string }) {
  const plainText = input.textBody?.trim();
  if (plainText) return plainText;
  if (!input.htmlBody?.trim()) return "";
  return convert(input.htmlBody, {
    wordwrap: false,
    preserveNewlines: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
    ],
  }).replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeCid(value: string) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = value;
  }
  return decoded.replace(/^cid:/i, "").replace(/[<>]/g, "").trim().toLocaleLowerCase();
}

function emailDocument(html: string) {
  const policy = [
    "default-src 'none'",
    "img-src data: http: https:",
    "style-src 'unsafe-inline' http: https:",
    "font-src data: http: https:",
    "media-src data: http: https:",
    "script-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<style>html{color-scheme:light}body{margin:0;padding:16px;color:#334155;background:#fff;font:14px/1.65 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow-wrap:anywhere}img,video{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a{color:#2563eb}</style>",
  ].join("");
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (opening) => `${opening}${head}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (opening) => `${opening}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

export async function renderOriginalEmail(rawSource: Buffer) {
  const parsed = await simpleParser(rawSource, { skipHtmlToText: true, skipTextToHtml: true });
  const attachments: RenderedEmailAttachment[] = parsed.attachments.map((attachment, index) => ({
    filename: attachment.filename || `附件 ${index + 1}`,
    contentType: attachment.contentType || "application/octet-stream",
    contentBase64: attachment.content.toString("base64"),
    size: attachment.size || attachment.content.length,
    inline: attachment.contentDisposition === "inline" || Boolean(attachment.cid),
  }));
  const inlineByCid = new Map<string, string>();
  parsed.attachments.forEach((attachment) => {
    if (!attachment.cid) return;
    inlineByCid.set(
      normalizeCid(attachment.cid),
      `data:${attachment.contentType || "application/octet-stream"};base64,${attachment.content.toString("base64")}`,
    );
  });
  const sourceHtml = typeof parsed.html === "string" ? parsed.html : "";
  const restoredHtml = sourceHtml.replace(/cid:([^"'\s)>]+)/gi, (original, cid: string) => (
    inlineByCid.get(normalizeCid(cid)) ?? original
  ));
  return {
    renderedHtml: restoredHtml ? emailDocument(restoredHtml) : "",
    attachments,
  };
}
