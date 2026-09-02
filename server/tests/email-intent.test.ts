import assert from "node:assert/strict";
import { test } from "node:test";
import { EMAIL_INTENTS, normalizeEmailIntent } from "../domain";

test("email intent enum contains exactly the eight product intents", () => {
  assert.deepEqual(EMAIL_INTENTS, [
    "投递确认",
    "面试邀请",
    "笔试邀请",
    "AI Coding邀请",
    "岗位推荐",
    "面试反馈",
    "录用通知",
    "拒绝信",
    "其他",
  ]);
});

test("legacy stored intents are normalized using subject and analysis context", () => {
  const cases = [
    [{ intent: "Offer", subject: "录用结果通知" }, "录用通知"],
    [{ intent: "rejection", analysis: { status: "rejected" } }, "拒绝信"],
    [{ intent: "面试反馈邀请", subject: "请填写面试体验问卷" }, "面试反馈"],
    [{ intent: "面试安排", subject: "技术面试邀约" }, "面试邀请"],
    [{ intent: "求职进展", subject: "AI Coding 测评邀请" }, "AI Coding邀请"],
    [{ intent: "投递申请", subject: "职位申请已收到" }, "投递确认"],
    [{ intent: "校园招聘", subject: "为你推荐岗位，欢迎投递" }, "岗位推荐"],
    [{ intent: "无法识别", subject: "每周新闻简报" }, "其他"],
    [{ intent: "录用通知", subject: "任意标题" }, "录用通知"],
  ] as const;

  for (const [input, expected] of cases) {
    assert.equal(normalizeEmailIntent(input), expected);
  }
});
