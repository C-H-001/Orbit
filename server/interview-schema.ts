import { z } from "zod";

const nullableTrimmed = z.string().nullish().transform((value) => value?.trim() || null);
const llmPositiveInteger = z.preprocess(
  (value) => typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value,
  z.number().int().min(1),
);

export const interviewCaptureDraftSchema = z.object({
  company: z.string(),
  position: z.string(),
  interviewRound: z.string().nullable(),
  interviewTime: nullableTrimmed,
  interviewEvaluation: z.string().nullable(),
  questions: z.array(z.object({
    order: z.number().finite(),
    question: z.string(),
    answer: z.string().nullable(),
  })),
}).transform((draft) => ({
  ...draft,
  questions: draft.questions.map((question, index) => ({
    ...question,
    order: index + 1,
  })),
}));

export const interviewCaptureDraftUpdateSchema = z.object({
  draft: interviewCaptureDraftSchema,
  revision: z.number().int().min(0),
}).strict();

export const interviewQuestionDraftSchema = z.object({
  order: z.number().int().min(1),
  question: z.string().trim().min(1),
  answer: nullableTrimmed,
});

const interviewOcrQuestionDraftSchema = interviewQuestionDraftSchema.extend({
  order: llmPositiveInteger,
});

export const interviewOcrDraftSchema = z.object({
  company: nullableTrimmed,
  position: nullableTrimmed,
  interviewRound: nullableTrimmed,
  interviewTime: nullableTrimmed,
  interviewEvaluation: nullableTrimmed,
  questions: z.array(interviewOcrQuestionDraftSchema).min(1),
}).strict().transform((draft) => ({
  ...draft,
  company: draft.company ?? "",
  position: draft.position ?? "",
  questions: draft.questions.map((question, index) => ({
    ...question,
    order: index + 1,
  })),
}));

export const interviewExperienceDraftSchema = z.object({
  company: z.string().trim().min(1),
  position: z.string().trim().min(1),
  interviewRound: nullableTrimmed,
  interviewTime: nullableTrimmed,
  interviewEvaluation: nullableTrimmed,
  questions: z.array(interviewQuestionDraftSchema).min(1),
}).strict().transform((draft) => ({
  ...draft,
  questions: draft.questions.map((question, index) => ({ ...question, order: index + 1 })),
}));

export const interviewExperienceUpdateSchema = interviewExperienceDraftSchema;
