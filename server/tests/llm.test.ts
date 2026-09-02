import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createChatCompletionsClient,
  createLlmClient,
  parseEmailAnalysisResponse,
  resolveChatCompletionsUrl,
} from "../llm";

test("chat completions URL is appended once", () => {
  assert.equal(
    resolveChatCompletionsUrl("https://llm.example.com/v1/"),
    "https://llm.example.com/v1/chat/completions",
  );
  assert.equal(
    resolveChatCompletionsUrl("https://llm.example.com/v1/chat/completions"),
    "https://llm.example.com/v1/chat/completions",
  );
});

test("email analysis accepts fenced JSON and rejects unsupported statuses", () => {
  const valid = parseEmailAnalysisResponse(`\`\`\`json
  {
    "relevant": true,
    "company": "星河科技",
    "position": "后端工程师",
    "intent": "面试邀请",
    "status": "ongoing",
    "currentProgress": "面试中",
    "nextAction": "准备面试",
    "appliedDate": "2026-08-01",
    "interviewTime": "2026-08-29T14:00:00.000Z",
    "eventDate": "2026-08-21",
    "detail": "技术面试邀请"
  }
  \`\`\``);
  assert.equal(valid.currentProgress, "面试中");

  assert.throws(
    () => parseEmailAnalysisResponse(JSON.stringify({ ...valid, status: "maybe" })),
    /Invalid model response/,
  );
  assert.throws(
    () => parseEmailAnalysisResponse(JSON.stringify({ ...valid, appliedDate: "下个月" })),
    /Invalid model response/,
  );
  assert.throws(
    () => parseEmailAnalysisResponse(JSON.stringify({ ...valid, appliedDate: "2026-02-31" })),
    /Invalid model response/,
  );
  assert.throws(
    () => parseEmailAnalysisResponse(JSON.stringify({ ...valid, interviewTime: "2026-08-29T14:00:00" })),
    /Invalid model response/,
  );
  assert.throws(
    () => parseEmailAnalysisResponse(JSON.stringify({ ...valid, appliedDate: "2026-08-22", eventDate: "2026-08-21" })),
    /Invalid model response/,
  );
});

test("email analysis only accepts the canonical intents", () => {
  const intents = [
    "投递确认",
    "面试邀请",
    "笔试邀请",
    "AI Coding邀请",
    "岗位推荐",
    "面试反馈",
    "录用通知",
    "拒绝信",
    "其他",
  ];
  const base = {
    relevant: true,
    company: "星河科技",
    position: "后端工程师",
    status: "ongoing",
    currentProgress: "其它",
    nextAction: null,
    appliedDate: null,
    interviewTime: null,
    assessmentTime: null,
    assessmentTimeType: null,
    eventDate: "2026-08-21",
    detail: null,
  };

  for (const intent of intents) {
    assert.equal(parseEmailAnalysisResponse(JSON.stringify({ ...base, intent })).intent, intent);
  }
  assert.throws(
    () => parseEmailAnalysisResponse(JSON.stringify({ ...base, intent: "面试安排" })),
    /Invalid model response/,
  );
  assert.throws(
    () => parseEmailAnalysisResponse(JSON.stringify({ ...base, intent: null })),
    /Invalid model response/,
  );
  assert.throws(
    () => parseEmailAnalysisResponse(JSON.stringify({ ...base, relevant: false, company: null, intent: "面试邀请" })),
    /Non-relevant email must use the 其他 intent/,
  );
});

test("email analysis normalizes nullable fields and falls back to the received date", () => {
  const irrelevant = parseEmailAnalysisResponse(JSON.stringify({
    relevant: false,
    company: null,
    position: null,
    intent: "其他",
    status: null,
    currentProgress: null,
    nextAction: null,
    appliedDate: null,
    interviewTime: null,
    eventDate: null,
    detail: null,
  }), { fallbackEventDate: "2026-08-25" });
  assert.deepEqual(irrelevant, {
    relevant: false,
    company: "",
    position: "",
    intent: "其他",
    status: null,
    currentProgress: null,
    nextAction: null,
    appliedDate: null,
    interviewTime: null,
    assessmentTime: null,
    assessmentTimeType: null,
    eventDate: "2026-08-25",
    detail: "",
  });

  const relevant = parseEmailAnalysisResponse(JSON.stringify({
    relevant: true,
    company: "蚂蚁集团",
    position: null,
    intent: "笔试邀请",
    status: "ongoing",
    currentProgress: "笔试中",
    nextAction: null,
    appliedDate: null,
    interviewTime: null,
    eventDate: null,
  }), { fallbackEventDate: "2026-05-11" });
  assert.equal(relevant.position, "");
  assert.equal(relevant.intent, "笔试邀请");
  assert.equal(relevant.detail, "");
  assert.equal(relevant.eventDate, "2026-05-11");

  assert.throws(
    () => parseEmailAnalysisResponse(JSON.stringify({ ...relevant, company: null })),
    /Relevant email must include a company/,
  );
});

test("LLM client returns validated analysis and usage from an OpenAI-compatible response", async () => {
  let requestedUrl = "";
  let authorization = "";
  const client = createLlmClient({
    getSettings: () => ({
      baseUrl: "https://llm.example.com/v1",
      model: "orbit-model",
      apiKey: "llm-secret",
    }),
    fetchImpl: async (url, init) => {
      requestedUrl = String(url);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              relevant: false,
              company: null,
              position: null,
              intent: "其他",
              status: "ongoing",
              currentProgress: null,
              nextAction: "",
              appliedDate: "2026-08-21",
              interviewTime: null,
              eventDate: null,
              detail: null,
            }),
          },
        }],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.classifyEmail({
    subject: "普通新闻简报",
    fromAddress: "news@example.com",
    receivedAt: "2026-08-21T09:00:00.000Z",
    textBody: "本周新闻",
  });

  assert.equal(result.analysis.relevant, false);
  assert.equal(result.analysis.eventDate, "2026-08-21");
  assert.equal(result.analysis.intent, "其他");
  assert.deepEqual(result.usage, {
    inputTokens: 120,
    imageTokens: 0,
    outputTokens: 30,
    reasoningTokens: 0,
  });
  assert.equal(requestedUrl, "https://llm.example.com/v1/chat/completions");
  assert.equal(authorization, "Bearer llm-secret");
});

test("chat transport protects model and messages while accepting caller options", async () => {
  let body: any;
  const client = createChatCompletionsClient({
    getSettings: () => ({
      baseUrl: "https://llm.example.com/v1",
      model: "configured-model",
      apiKey: "fake-llm-key",
    }),
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: "OK" } }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          prompt_tokens_details: { image_tokens: 7 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const messages = [{ role: "user" as const, content: "hello" }];

  const result = await client.request(messages, {
    extraBody: {
      model: "caller-model",
      messages: [{ role: "user", content: "replaced" }],
      temperature: 0.25,
      enable_thinking: false,
    },
    timeoutMs: 90_000,
  });

  assert.equal(body.model, "configured-model");
  assert.deepEqual(body.messages, messages);
  assert.equal(body.temperature, 0.25);
  assert.equal(body.enable_thinking, false);
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    imageTokens: 7,
    outputTokens: 3,
    reasoningTokens: 2,
  });
});

test("email classifier instructs the model to canonicalize company and position aliases", async () => {
  let messages: Array<{ role: string; content: string }> = [];
  const client = createLlmClient({
    getSettings: () => ({
      baseUrl: "https://llm.example.com/v1",
      model: "orbit-model",
      apiKey: "llm-secret",
    }),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      messages = body.messages;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              relevant: true,
              company: "华为",
              position: "Agent基础设施工程",
              intent: "投递确认",
              status: "ongoing",
              currentProgress: "已投递",
              nextAction: null,
              appliedDate: null,
              interviewTime: null,
              eventDate: "2026-08-21",
              detail: "投递成功",
            }),
          },
        }],
        usage: { prompt_tokens: 200, completion_tokens: 40 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await client.classifyEmail({
    subject: "huawei 转正实习 Agent基础设施工程投递成功",
    fromAddress: "recruiting@huawei.com",
    receivedAt: "2026-08-21T09:00:00.000Z",
    textBody: "感谢应聘【转正实习】Agent基础设施工程。",
  });

  const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
  assert.match(systemPrompt, /相同公司.*同一个规范名称/);
  assert.match(systemPrompt, /huawei\s*\/\s*华为公司\s*\/\s*华为\s*→\s*华为/i);
  assert.match(
    systemPrompt,
    /转正实习 Agent基础设施工程\s*\/\s*【转正实习】Agent基础设施工程\s*\/\s*Agent基础设施工程（转正实习）\s*→\s*Agent基础设施工程/,
  );
  assert.match(systemPrompt, /不要删除岗位本身必要的.*实习生/);
  assert.match(systemPrompt, /投递确认、面试邀请、笔试邀请、AI Coding邀请、岗位推荐、面试反馈、录用通知、拒绝信、其他/);
  assert.match(systemPrompt, /录用通知.*拒绝信.*面试反馈.*面试邀请.*笔试邀请.*投递确认.*岗位推荐.*其他/s);
  assert.match(systemPrompt, /非求职申请邮件.*intent=其他/);
});
