import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import * as OverviewModule from "../../src/pages/Overview";
import { Overview } from "../../src/pages/Overview";
import type { Application } from "../../src/types";

function progressLabel() {
  const currentProgressLabel = (OverviewModule as unknown as {
    currentProgressLabel?: (progress: string, status: Application["status"]) => string;
  }).currentProgressLabel;
  assert.equal(typeof currentProgressLabel, "function");
  return currentProgressLabel!;
}

test("overview renders the canonical progress independently from application status", () => {
  for (const progress of ["已投递", "笔试中", "面试中", "阻塞（需要预约时间）", "其它"]) {
    assert.equal(progressLabel()(progress, "ongoing"), progress);
  }
  assert.equal(progressLabel()("面试中", "offer"), "面试中");
  assert.equal(progressLabel()("其它", "rejected"), "其它");
});

test("overview renders only the application's current recruitment progress", () => {
  const application: Application = {
    id: "app-1",
    accountId: "primary",
    company: "星河科技",
    position: "后端工程师",
    trackType: "job",
    status: "ongoing",
    currentProgress: "面试中",
    nextAction: "参加面试",
    appliedDate: "2026-08-01",
    completed: false,
    timeline: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
  const markup = renderToStaticMarkup(createElement(Overview, {
    applications: [application],
    searchQuery: "",
    onSelectApp: () => undefined,
    onAddApplication: async () => true,
    onUpdateApp: async () => true,
    onDeleteApplication: async () => true,
    onRestoreApplication: async () => true,
    onExport: async () => undefined,
  }));
  const progressStart = markup.indexOf('aria-label="当前招聘进度"');
  const progressEnd = markup.indexOf("</div>", progressStart);
  const progressMarkup = markup.slice(progressStart, progressEnd);

  assert.ok(progressStart >= 0);
  assert.match(progressMarkup, />面试中<\/span>/);
  assert.equal((progressMarkup.match(/>面试中<\/span>/g) ?? []).length, 1);
});
