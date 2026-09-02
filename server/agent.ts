import type { AgentProposal } from "./domain";
import type { OrbitRepository } from "./repository";
import { normalizeRecruitmentProgress } from "../shared/recruitment-progress";

interface AnswerResult {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export function createAgentService(options: {
  repository: OrbitRepository;
  answerQuestion: (input: { message: string; context: string }) => Promise<AnswerResult>;
}) {
  async function chat(message: string): Promise<{ message: string; proposal?: AgentProposal }> {
    const updateMatch = message.match(/(?:将|把|mark)\s*(.+?)\s*(?:标记为|改为|as)\s*(.+)/i);
    if (updateMatch) {
      const company = updateMatch[1]!.trim();
      const newStage = normalizeRecruitmentProgress(updateMatch[2]!.trim());
      const application = options.repository.listApplications().find((item) =>
        !item.deletedAt && item.company.toLocaleLowerCase().includes(company.toLocaleLowerCase()),
      );
      if (!application) return { message: `找不到公司“${company}”的申请记录，请检查名称后重试。` };
      const proposal = options.repository.createAgentProposal(
        application.id,
        { currentProgress: application.currentProgress },
        { currentProgress: newStage },
      );
      return {
        message: `准备将 ${application.company} 的进度从 ${application.currentProgress} 更新为 ${newStage}。`,
        proposal,
      };
    }

    const applications = options.repository.listApplications().filter((item) => !item.deletedAt);
    const emails = options.repository.listEmails().slice(0, 20).map((email) => ({
      subject: email.subject,
      company: email.company,
      position: email.position,
      intent: email.intent,
      status: email.status,
      receivedAt: email.receivedAt,
    }));
    const context = JSON.stringify({ applications, recentEmails: emails });
    try {
      const result = await options.answerQuestion({ message, context });
      options.repository.recordLlmUsage({
        model: result.model,
        prompt: "申请与邮件问答",
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        status: "success",
      });
      return { message: result.content };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.repository.recordLlmUsage({
        model: "configured-model",
        prompt: "申请与邮件问答",
        inputTokens: 0,
        outputTokens: 0,
        status: "failure",
        errorMessage: detail,
      });
      throw error;
    }
  }

  function confirmProposal(id: string, confirmed: boolean) {
    return options.repository.confirmAgentProposal(id, confirmed);
  }

  return { chat, confirmProposal };
}

export type AgentService = ReturnType<typeof createAgentService>;
