import assert from "node:assert/strict";
import { test } from "node:test";
import { extractReadableEmailText } from "../email-content";

test("plain text wins and HTML-only mail is converted into readable text", () => {
  assert.equal(extractReadableEmailText({
    textBody: "  已有纯文本正文  ",
    htmlBody: "<p>不应覆盖纯文本</p>",
  }), "已有纯文本正文");

  const converted = extractReadableEmailText({
    textBody: "",
    htmlBody: `
      <html><head><style>.hidden{display:none}</style><script>bad()</script></head>
      <body><h1>面试邀请</h1><p>岗位：后端工程师</p><p>时间：明天下午</p>
      <img src="https://tracking.invalid/pixel.gif" /></body></html>
    `,
  });
  assert.match(converted, /面试邀请/);
  assert.match(converted, /岗位：后端工程师/);
  assert.doesNotMatch(converted, /bad\(\)|tracking\.invalid|display:none/);
});
