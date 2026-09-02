import { z } from "zod";
import { EMAIL_INTENTS, type Application, type EmailAnalysis } from "./domain";
import { RECRUITMENT_PROGRESS_VALUES } from "../shared/recruitment-progress";

function isValidCalendarDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidZonedDateTime(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  return Boolean(match && isValidCalendarDate(match[1]!) && !Number.isNaN(Date.parse(value)));
}

const isoDate = z.string().refine(isValidCalendarDate, "Invalid date");
const isoDateTime = z.string().refine(isValidZonedDateTime, "Invalid zoned date-time");
const nullableText = z.string().nullish().transform((value) => value?.trim() || null);

const rawEmailAnalysisSchema = z.object({
  relevant: z.boolean(),
  company: nullableText,
  position: nullableText,
  intent: z.enum(EMAIL_INTENTS),
  status: z.enum(["ongoing", "offer", "rejected", "withdrawn"]).nullish().transform((value) => value ?? null),
  currentProgress: z.enum(RECRUITMENT_PROGRESS_VALUES).nullish().transform((value) => value ?? null),
  nextAction: nullableText,
  appliedDate: isoDate.nullish().transform((value) => value ?? null),
  interviewTime: isoDateTime.nullish().transform((value) => value ?? null),
  assessmentTime: z.union([isoDate, isoDateTime]).nullish().transform((value) => value ?? null),
  assessmentTimeType: z.enum(["scheduled", "deadline"]).nullish().transform((value) => value ?? null),
  eventDate: isoDate.nullish().transform((value) => value ?? null),
  detail: nullableText,
});

const chatResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string() }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().optional().default(0),
    completion_tokens: z.number().optional().default(0),
    prompt_tokens_details: z.object({
      image_tokens: z.number().optional().default(0),
    }).optional(),
    completion_tokens_details: z.object({
      reasoning_tokens: z.number().optional().default(0),
    }).optional(),
  }).optional(),
});

const applicationCandidateMatchSchema = z.object({
  matchedApplicationId: z.string().uuid().nullable(),
  confidence: z.number().min(0).max(1),
}).strict();

interface LlmSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
}

interface EmailForClassification {
  subject: string;
  fromAddress: string;
  receivedAt: string;
  textBody: string;
}

export type MessageContent = string | Array<
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
>;

export interface LlmUsage {
  inputTokens: number;
  imageTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: MessageContent };

export function resolveChatCompletionsUrl(baseUrl: string) {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("LLM base URL is not configured");
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

export function parseEmailAnalysisResponse(content: string, options?: { fallbackEventDate?: string }): EmailAnalysis {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = rawEmailAnalysisSchema.parse(JSON.parse(stripped));
    const eventDate = parsed.eventDate ?? options?.fallbackEventDate;
    if (!eventDate || !isValidCalendarDate(eventDate)) throw new Error("A valid event date is required");
    if (parsed.relevant && !parsed.company) throw new Error("Relevant email must include a company");
    if (parsed.relevant && parsed.intent === "面试邀请" && !parsed.position) throw new Error("Interview invitation must include a position");
    if (parsed.relevant && !parsed.currentProgress) throw new Error("Relevant email must include a recruitment progress");
    if (!parsed.relevant && parsed.intent !== "其他") throw new Error("Non-relevant email must use the 其他 intent");
    if (!parsed.relevant && parsed.currentProgress !== null) throw new Error("Non-relevant email must not include a recruitment progress");
    if (parsed.appliedDate && parsed.appliedDate > eventDate) {
      throw new Error("Applied date must not be after the email event date");
    }
    return {
      relevant: parsed.relevant,
      company: parsed.company ?? "",
      position: parsed.position ?? "",
      intent: parsed.intent,
      status: parsed.status,
      currentProgress: parsed.currentProgress,
      nextAction: parsed.nextAction,
      appliedDate: parsed.appliedDate,
      interviewTime: parsed.interviewTime,
      assessmentTime: parsed.assessmentTime,
      assessmentTimeType: parsed.assessmentTime ? parsed.assessmentTimeType : null,
      eventDate,
      detail: parsed.detail ?? "",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid model response: ${detail}`);
  }
}

export function createChatCompletionsClient(options: {
  getSettings: () => LlmSettings;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(
    messages: ChatMessage[],
    requestOptions: { extraBody?: Record<string, unknown>; timeoutMs?: number } = {},
  ) {
    const settings = options.getSettings();
    if (!settings.model.trim()) throw new Error("LLM model is not configured");
    if (!settings.apiKey.trim()) throw new Error("LLM API key is not configured");
    const { temperature = 0, ...extraBody } = requestOptions.extraBody ?? {};

    const response = await fetchImpl(resolveChatCompletionsUrl(settings.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...extraBody,
        model: settings.model,
        messages,
        temperature,
      }),
      signal: AbortSignal.timeout(requestOptions.timeoutMs ?? 30_000),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${body.slice(0, 300)}`);
    }
    const parsed = chatResponseSchema.parse(await response.json());
    return {
      content: parsed.choices[0]!.message.content,
      usage: {
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        imageTokens: parsed.usage?.prompt_tokens_details?.image_tokens ?? 0,
        outputTokens: parsed.usage?.completion_tokens ?? 0,
        reasoningTokens: parsed.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      },
    };
  }

  return { request };
}

export function createLlmClient(options: {
  getSettings: () => LlmSettings;
  fetchImpl?: typeof fetch;
}) {
  const transport = createChatCompletionsClient(options);

  async function classifyEmail(email: EmailForClassification) {
    const result = await transport.request([
      {
        role: "system",
        content: [
          "你是 Orbit 的求职申请邮件分类器。你的任务是从邮件事实中提取结构化求职进展，并让同一申请在不同邮件中的公司名和岗位名保持一致。",
          "只返回一个 JSON 对象，不要 Markdown、解释或额外字段。",
          "字段必须为 relevant, company, position, intent, status, currentProgress, nextAction, appliedDate, interviewTime, assessmentTime, assessmentTimeType, eventDate, detail。",
          "",
          "事实与格式规则：",
          "- status 只能是 ongoing, offer, rejected, withdrawn 或 null。",
          "- intent 必须且只能是：投递确认、面试邀请、笔试邀请、AI Coding邀请、岗位推荐、面试反馈、录用通知、拒绝信、其他。禁止返回 null、空字符串、英文值或其他近义词。",
          "- currentProgress 在 relevant=true 时必须且只能是：已投递、笔试中、AI Coding中、面试中、阻塞（需要预约时间）、已拒绝、其它。relevant=false 时返回 null。",
          "- 邮件没有明确提供 position、detail、status、nextAction、appliedDate、interviewTime、assessmentTime 时返回 null，禁止猜测。assessmentTime=null 时 assessmentTimeType=null。",
          "- relevant=true 时 company 必须给出；relevant=false 时 company/position/detail 可以为 null，但 intent 必须为其他。",
          "- appliedDate/eventDate 使用 YYYY-MM-DD；interviewTime 使用带时区的 ISO 8601；assessmentTime 有具体时间时使用带时区 ISO 8601，只有日期时使用 YYYY-MM-DD，未知为 null。",
          "- 非求职申请邮件将 relevant 设为 false、intent=其他，eventDate 使用邮件日期。",
          "- currentProgress=已投递：投递成功、简历已收到或等待评估。",
          "- currentProgress=笔试中：普通笔试、在线测评或 Assessment 流程。",
          "- currentProgress=AI Coding中：明确为 AI Coding 或 Coding Test；不要归入普通笔试。",
          "- currentProgress=面试中：面试邀请或已有固定面试时间；不区分一面、二面、三面。面试反馈、结果、问卷不属于面试中。",
          "- currentProgress=阻塞（需要预约时间）：必须由候选人选择、预约、提供或确认时间后流程才能继续。已有固定时间不属于阻塞。",
          "- currentProgress=已拒绝：拒绝信、未通过、流程终止或明确不再推进。",
          "- currentProgress=其它：岗位推荐、录用、普通通知或无法归入以上流程；录用仍通过 status 表达。",
          "- intent=面试反馈 时 currentProgress 必须为其它；这类邮件只记录在邮箱，不推动申请进度。",
          "- 笔试邀请和 AI Coding邀请必须提取 company 与 assessmentTime；position 可以为 null，不能为了匹配职位而猜测。",
          "- assessmentTimeType=deadline：邮件表达“截止、截至、请于某时前完成、有效期至”；assessmentTimeType=scheduled：邮件表达明确的考试开始或安排时间。无法判断时为 null。",
          "- 只有“收到后若干天内”这类相对期限且没有绝对日期时，不计算 assessmentTime，保留 detail 并将 assessmentTimeType=deadline。",
          "- 面试邀请必须提取明确的 position；缺少职位时不要猜测。",
          "",
          "intent 判定规则（出现重叠时严格按以下优先级从上到下选择一个）：",
          "1. 录用通知：明确给出 Offer、录用、聘用、入职或签约信息。",
          "2. 拒绝信：明确表示未通过、不录用、流程终止或不再推进。",
          "3. 面试反馈：面试结果、反馈、评价、体验调查或面试问卷；它不是新的面试邀请。",
          "4. 面试邀请：邀请或安排候选人参加一面、二面、三面、终面等面试。",
          "5. AI Coding邀请：明确要求完成 AI Coding 或 Coding Test。",
          "6. 笔试邀请：普通笔试、在线测评或 Assessment，不包括 AI Coding。",
          "7. 投递确认：确认职位申请、简历或投递已成功提交、收到或受理。",
          "8. 岗位推荐：推荐职位或邀请候选人申请/投递某岗位，但尚未确认已投递。",
          "9. 其他：不符合以上类别，包括普通通知和非求职邮件。",
          "- 示例：‘感谢申请，我们已收到你的简历’ → 投递确认；‘为你推荐算法工程师岗位，欢迎投递’ → 岗位推荐。",
          "- 示例：‘请完成 AI Coding 测评’ → 笔试邀请；‘请确认二面时间’ → 面试邀请。",
          "- 示例：‘请填写面试体验问卷’ → 面试反馈；‘很遗憾本次未通过’ → 拒绝信；‘录用及入职通知’ → 录用通知。",
          "",
          "实体规范化规则（输出 company 和 position 前必须执行）：",
          "- 相同公司即使使用英文名、大小写变体、品牌名或带“公司/集团”等组织后缀，也必须输出同一个规范名称；优先使用公众常用的简洁中文品牌名。",
          "- 仅在确定是同一雇主时合并名称；不同子公司、事业群或独立品牌如果会改变申请归属，必须保留其区别，禁止仅凭词语相近强行合并。",
          "- 同一岗位的中英文括号、空格、装饰符号以及位于岗位名称外围的招聘属性不应制造新岗位名称。",
          "- position 保留岗位的核心职能和技术方向；可以去掉位于开头、结尾或括号标签中的“转正实习”等招聘属性，但不要删除岗位本身必要的“实习生”、职级、方向或专业限定。",
          "- 岗位中的业务方向和地点属于必要限定，必须保留。例如“AI应用后端开发实习生-国际支付-杭州”不能缩写为“AI应用后端开发实习生”。",
          "- 只有语义确定相同才合并；无法确定时保留邮件中的明确写法，不要猜测。",
          "",
          "规范化示例：",
          "- 公司：huawei / 华为公司 / 华为 → 华为",
          "- 岗位：转正实习 Agent基础设施工程 / 【转正实习】Agent基础设施工程 / Agent基础设施工程（转正实习） → Agent基础设施工程",
          "- 因此，上述公司和岗位的任意组合都必须稳定输出 company=华为、position=Agent基础设施工程，以便归入同一条申请记录。",
        ].join("\n"),
      },
      {
        role: "user",
        content: `主题：${email.subject}\n发件人：${email.fromAddress}\n收件时间：${email.receivedAt}\n正文：\n${email.textBody.slice(0, 20_000)}`,
      },
    ]);
    const receivedDate = new Date(email.receivedAt);
    if (Number.isNaN(receivedDate.getTime())) throw new Error("Email received date is invalid");
    return {
      analysis: parseEmailAnalysisResponse(result.content, { fallbackEventDate: receivedDate.toISOString().slice(0, 10) }),
      usage: result.usage,
    };
  }

  async function matchApplicationCandidate(input: {
    email: EmailForClassification;
    analysis: EmailAnalysis;
    candidates: Array<Pick<Application, "id" | "company" | "position" | "currentProgress">>;
  }) {
    if (input.candidates.length === 0) {
      return { matchedApplicationId: null, usage: { inputTokens: 0, imageTokens: 0, outputTokens: 0, reasoningTokens: 0 } };
    }
    const result = await transport.request([
      {
        role: "system",
        content: [
          "你是 Orbit 的申请候选匹配器。只返回 JSON：matchedApplicationId, confidence。",
          "根据邮件原文、已提取岗位和同公司现有职位候选，判断邮件属于哪个现有申请。",
          "岗位简称、大小写和空格差异可以匹配；业务方向、地点、职级不同通常不是同一岗位。",
          "如果邮件正文明确出现某候选的完整岗位名，即使提取岗位被缩短，也应匹配该候选。",
          "只有证据明确时返回候选 ID；不确定、多个候选都可能或确实是新岗位时返回 null。",
          "不得返回候选列表之外的 ID。confidence 使用 0 到 1。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `邮件主题：${input.email.subject}`,
          `邮件正文：\n${input.email.textBody.slice(0, 12_000)}`,
          `提取结果：${JSON.stringify({ company: input.analysis.company, position: input.analysis.position, intent: input.analysis.intent, detail: input.analysis.detail })}`,
          `现有候选：${JSON.stringify(input.candidates)}`,
        ].join("\n\n"),
      },
    ]);
    const parsed = applicationCandidateMatchSchema.parse(JSON.parse(
      result.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""),
    ));
    const validId = input.candidates.some((candidate) => candidate.id === parsed.matchedApplicationId);
    return {
      matchedApplicationId: validId && parsed.confidence >= 0.8 ? parsed.matchedApplicationId : null,
      usage: result.usage,
    };
  }

  return { classifyEmail, matchApplicationCandidate, request: transport.request };
}

export type LlmClient = ReturnType<typeof createLlmClient>;
