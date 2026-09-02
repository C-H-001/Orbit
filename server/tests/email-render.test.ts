import assert from "node:assert/strict";
import { test } from "node:test";
import * as EmailContentModule from "../email-content";

const MIME_WITH_INLINE_AND_REMOTE_IMAGES = Buffer.from([
  "From: jobs@example.com",
  "To: candidate@example.com",
  "Subject: Rich email",
  "MIME-Version: 1.0",
  'Content-Type: multipart/related; boundary="orbit-boundary"',
  "",
  "--orbit-boundary",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<html><body><p>面试邀请正文</p><img src="cid:logo@orbit"><img src="https://images.example.com/banner.png"><script>alert(1)</script></body></html>',
  "--orbit-boundary",
  "Content-Type: image/png",
  "Content-Transfer-Encoding: base64",
  "Content-ID: <logo@orbit>",
  'Content-Disposition: inline; filename="logo.png"',
  "",
  "aGVsbG8=",
  "--orbit-boundary",
  "Content-Type: application/pdf",
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="offer.pdf"',
  "",
  "cGRm",
  "--orbit-boundary--",
  "",
].join("\r\n"));

test("original email rendering restores cid images and keeps remote images loadable", async () => {
  const renderOriginalEmail = (EmailContentModule as unknown as {
    renderOriginalEmail?: (source: Buffer) => Promise<{
      renderedHtml: string;
      attachments: Array<{ filename: string; contentType: string; contentBase64: string; inline: boolean }>;
    }>;
  }).renderOriginalEmail;
  assert.equal(typeof renderOriginalEmail, "function");

  const rendered = await renderOriginalEmail!(MIME_WITH_INLINE_AND_REMOTE_IMAGES);

  assert.match(rendered.renderedHtml, /data:image\/png;base64,aGVsbG8=/);
  assert.match(rendered.renderedHtml, /https:\/\/images\.example\.com\/banner\.png/);
  assert.doesNotMatch(rendered.renderedHtml, /cid:logo@orbit/);
  assert.match(rendered.renderedHtml, /img-src data: http: https:/);
  assert.match(rendered.renderedHtml, /script-src 'none'/);
  assert.deepEqual(rendered.attachments.map((attachment) => ({
    filename: attachment.filename,
    contentType: attachment.contentType,
    inline: attachment.inline,
  })), [
    { filename: "logo.png", contentType: "image/png", inline: true },
    { filename: "offer.pdf", contentType: "application/pdf", inline: false },
  ]);
  assert.equal(rendered.attachments[1]?.contentBase64, "cGRm");
});
