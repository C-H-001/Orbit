import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createAgentService } from "../agent";
import { createRepository } from "../repository";

const cleanupDirectories: string[] = [];

function temporaryDatabasePath() {
  const directory = mkdtempSync(path.join(tmpdir(), "orbit-agent-"));
  cleanupDirectories.push(directory);
  return path.join(directory, "orbit.sqlite");
}

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an explicit chat update creates a proposal without changing the application", async () => {
  const repository = createRepository(temporaryDatabasePath());
  const application = repository.createApplication({
    company: "星河科技",
    position: "后端工程师",
    appliedDate: "2026-08-01",
  });
  const agent = createAgentService({
    repository,
    answerQuestion: async () => ({ content: "unused", usage: { inputTokens: 0, outputTokens: 0 }, model: "orbit-model" }),
  });

  const response = await agent.chat("将星河科技标记为二面");

  assert.ok(response.proposal);
  assert.equal(response.proposal?.applicationId, application.id);
  assert.equal(response.proposal?.before.currentProgress, "已投递");
  assert.equal(response.proposal?.after.currentProgress, "面试中");
  assert.equal(repository.getApplication(application.id)?.currentProgress, "已投递");
  repository.close();
});

test("confirming a chat proposal applies it once and appends an audited timeline event", async () => {
  const repository = createRepository(temporaryDatabasePath());
  const application = repository.createApplication({
    company: "星河科技",
    position: "后端工程师",
    appliedDate: "2026-08-01",
  });
  const agent = createAgentService({
    repository,
    answerQuestion: async () => ({ content: "unused", usage: { inputTokens: 0, outputTokens: 0 }, model: "orbit-model" }),
  });
  const response = await agent.chat("将星河科技标记为二面");

  const first = agent.confirmProposal(response.proposal!.id, true);
  const second = agent.confirmProposal(response.proposal!.id, true);

  assert.equal(first.status, "applied");
  assert.equal(second.status, "applied");
  assert.equal(repository.getApplication(application.id)?.currentProgress, "面试中");
  assert.equal(repository.getApplication(application.id)?.timeline.length, 2);
  assert.deepEqual(repository.listAuditEntries().map((entry) => entry.action), ["create", "update"]);
  repository.close();
});

test("a normal chat question is answered from current application and email context", async () => {
  const repository = createRepository(temporaryDatabasePath());
  repository.createApplication({
    company: "星河科技",
    position: "后端工程师",
    appliedDate: "2026-08-01",
  });
  let receivedContext = "";
  const agent = createAgentService({
    repository,
    answerQuestion: async ({ context }) => {
      receivedContext = context;
      return { content: "你有 1 条进行中的申请。", usage: { inputTokens: 80, outputTokens: 12 }, model: "orbit-model" };
    },
  });

  const response = await agent.chat("我有哪些进行中的申请？");

  assert.equal(response.message, "你有 1 条进行中的申请。");
  assert.match(receivedContext, /星河科技/);
  assert.equal(repository.getUsageSummary(7).totalCalls, 1);
  repository.close();
});
