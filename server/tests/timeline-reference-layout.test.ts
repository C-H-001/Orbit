import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { ApplicationDrawer } from "../../src/components/ApplicationDrawer";
import type { Application } from "../../src/types";

test("timeline places the original-email button in the date reference column", () => {
  const application: Application = {
    id: "app-1",
    accountId: "primary",
    company: "星河科技",
    position: "后端工程师",
    trackType: "job",
    status: "ongoing",
    currentProgress: "面试中",
    nextAction: "准备面试",
    appliedDate: "2026-08-01",
    completed: false,
    timeline: [{
      id: "timeline-1",
      stage: "一面",
      date: "2026-08-21",
      source: "email",
      sourceEmailId: "email-1",
    }],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };

  const markup = renderToStaticMarkup(createElement(ApplicationDrawer, {
    app: application,
    onClose: () => undefined,
    onOpenEmail: async () => undefined,
  }));
  const referenceColumnStart = markup.indexOf('aria-label="进展日期和原邮件"');
  const referenceColumnEnd = markup.indexOf("</aside>", referenceColumnStart);
  const dateIndex = markup.indexOf("2026-08-21", referenceColumnStart);
  const buttonIndex = markup.indexOf(">查看原邮件</button>", referenceColumnStart);

  assert.ok(referenceColumnStart >= 0);
  assert.ok(dateIndex > referenceColumnStart && dateIndex < referenceColumnEnd);
  assert.ok(buttonIndex > dateIndex && buttonIndex < referenceColumnEnd);
});
