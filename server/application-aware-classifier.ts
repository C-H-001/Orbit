import type { LlmClient } from "./llm"
import type { OrbitRepository } from "./repository"

export function createApplicationAwareClassifier(options: {
  repository: OrbitRepository
  llmClient: LlmClient
  getModel: () => string
}) {
  return {
    async classifyEmail(email: {
      subject: string
      fromAddress: string
      receivedAt: string
      textBody: string
    }) {
      const classified = await options.llmClient.classifyEmail(email)
      const analysis = classified.analysis
      const jobIntent = !["笔试邀请", "AI Coding邀请", "面试反馈"].includes(analysis.intent)
      if (!analysis.relevant || !jobIntent || !analysis.company.trim()) {
        return { ...classified, model: options.getModel() }
      }

      const companyKey = analysis.company.trim().toLocaleLowerCase()
      const candidates = options.repository.listApplications()
        .filter((application) =>
          !application.deletedAt
          && application.trackType === "job"
          && application.company.trim().toLocaleLowerCase() === companyKey
          && Boolean(application.position.trim()),
        )
        .map(({ id, company, position, currentProgress }) => ({ id, company, position, currentProgress }))
      if (candidates.length === 0) return { ...classified, model: options.getModel() }

      const matched = await options.llmClient.matchApplicationCandidate({ email, analysis, candidates })
      return {
        analysis: { ...analysis, matchedApplicationId: matched.matchedApplicationId },
        usage: {
          inputTokens: classified.usage.inputTokens + matched.usage.inputTokens,
          imageTokens: classified.usage.imageTokens + matched.usage.imageTokens,
          outputTokens: classified.usage.outputTokens + matched.usage.outputTokens,
          reasoningTokens: classified.usage.reasoningTokens + matched.usage.reasoningTokens,
        },
        model: options.getModel(),
      }
    },
  }
}
