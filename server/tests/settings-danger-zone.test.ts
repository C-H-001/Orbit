import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { createSettingsMutationGuard, SystemSettings } from "../../src/pages/SystemSettings";

test("settings data management exposes a red bulk-delete action", () => {
  const markup = renderToStaticMarkup(createElement(SystemSettings));

  assert.match(markup, />删除所有申请记录<\/button>/);
  assert.match(markup, /删除后无法恢复/);
  assert.match(markup, /text-red-600/);
});

test("settings exposes controlled OCR connection fields in the model card", () => {
  const markup = renderToStaticMarkup(createElement(SystemSettings));

  assert.match(markup, /面经 OCR 视觉模型/);
  assert.match(markup, /OCR 接口地址/);
  assert.match(markup, /OCR 模型名称/);
  assert.match(markup, /OCR API 密钥/);
  assert.match(markup, />测试 OCR 连接<\/button>/);
});

test("settings stay disabled and no mutation starts before delayed loading completes", async () => {
  const markup = renderToStaticMarkup(createElement(SystemSettings));
  assert.match(markup, /<fieldset[^>]*disabled=""/);

  const guard = createSettingsMutationGuard();
  const started: string[] = [];
  const busyStates: boolean[] = [];
  let releaseSave: (() => void) | undefined;
  const delayedSave = new Promise<void>((resolve) => { releaseSave = resolve; });

  assert.equal(await guard.run(async () => { started.push("premature-put"); }), false);
  guard.markLoaded();
  const first = guard.run(async () => {
    started.push("save");
    await delayedSave;
  }, (busy) => busyStates.push(busy));
  await Promise.resolve();
  assert.equal(await guard.run(async () => { started.push("overlapping-test"); }), false);
  assert.deepEqual(started, ["save"]);
  assert.deepEqual(busyStates, [true]);

  releaseSave?.();
  assert.equal(await first, true);
  assert.deepEqual(busyStates, [true, false]);
});
