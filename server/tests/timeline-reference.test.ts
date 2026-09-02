import assert from "node:assert/strict";
import { test } from "node:test";
import { getTimelineReference } from "../../src/timelineReference";

test("timeline reference is enabled only when a source email exists", () => {
  assert.deepEqual(getTimelineReference("email-123"), {
    label: "查看原邮件",
    emailId: "email-123",
    disabled: false,
  });
  assert.deepEqual(getTimelineReference(undefined), {
    label: "查看原邮件",
    emailId: undefined,
    disabled: true,
  });
});
