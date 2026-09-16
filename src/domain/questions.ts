import { RunnerError } from "./contracts.js";
type AgentCliKind = "codex" | "claudeCode";

export interface AgentQuestionOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface AgentQuestion {
  readonly id: string;
  readonly header: string;
  readonly prompt: string;
  readonly options: readonly AgentQuestionOption[];
  readonly multiple: boolean;
  readonly allowCustom: boolean;
}

export interface AgentQuestionAnswer {
  readonly questionId: string;
  readonly optionIds: readonly string[];
  readonly text: string;
}

export interface AgentQuestionResponse {
  readonly answers: readonly AgentQuestionAnswer[];
}

interface AgentQuestionRequestBase {
  readonly id: string;
  readonly taskId: string;
  readonly provider: AgentCliKind;
  readonly questions: readonly AgentQuestion[];
}

export type AgentQuestionRequest = AgentQuestionRequestBase &
  (
    | { readonly status: "pending" | "cancelled" | "expired" }
    | { readonly status: "answered"; readonly answers: readonly AgentQuestionAnswer[] }
  );

export const MAX_AGENT_QUESTIONS = 4;
export const MAX_AGENT_QUESTION_OPTIONS = 12;
export const MAX_AGENT_QUESTION_TEXT_BYTES = 8192;

function invalid(): never {
  throw new RunnerError("invalid_input");
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== fields.length ||
    !fields.every((field) => Object.prototype.hasOwnProperty.call(result, field))
  )
    return invalid();
  return result;
}

function text(value: unknown, maxBytes: number, blank = false): string {
  if (
    typeof value !== "string" ||
    value.length > maxBytes ||
    (!blank && value.trim().length === 0) ||
    value.includes("\0") ||
    new TextEncoder().encode(value).length > maxBytes
  )
    return invalid();
  return value;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))
    return invalid();
  return value;
}

function array(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value;
}

function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalid();
}

function parseQuestion(value: unknown): AgentQuestion {
  const item = record(value, ["id", "header", "prompt", "options", "multiple", "allowCustom"]);
  if (typeof item.multiple !== "boolean" || typeof item.allowCustom !== "boolean") invalid();
  const options = array(item.options, MAX_AGENT_QUESTION_OPTIONS).map((value) => {
    const option = record(value, ["id", "label", "description"]);
    return {
      id: id(option.id),
      label: text(option.label, 512),
      description: text(option.description, 2048, true),
    };
  });
  unique(options.map((option) => option.id));
  if (options.length === 0 && !item.allowCustom) invalid();
  return {
    id: id(item.id),
    header: text(item.header, 128, true),
    prompt: text(item.prompt, MAX_AGENT_QUESTION_TEXT_BYTES),
    options,
    multiple: item.multiple,
    allowCustom: item.allowCustom,
  };
}

/** Validates exact question membership, without leaking provider protocol identifiers. */
export function parseAgentQuestionResponse(
  value: unknown,
  request: Pick<AgentQuestionRequest, "questions">,
): AgentQuestionResponse {
  const item = record(value, ["answers"]);
  const answers = array(item.answers, MAX_AGENT_QUESTIONS).map((value) => {
    const answer = record(value, ["questionId", "optionIds", "text"]);
    const questionId = id(answer.questionId);
    const question = request.questions.find((question) => question.id === questionId);
    if (!question) return invalid();
    const optionIds = array(answer.optionIds, MAX_AGENT_QUESTION_OPTIONS).map(id);
    unique(optionIds);
    if (
      (!question.multiple && optionIds.length > 1) ||
      optionIds.some((id) => !question.options.some((option) => option.id === id))
    )
      invalid();
    const answerText = text(answer.text, MAX_AGENT_QUESTION_TEXT_BYTES, true);
    if ((!question.allowCustom && answerText !== "") || (!optionIds.length && !answerText.trim()))
      invalid();
    return { questionId, optionIds, text: answerText };
  });
  unique(answers.map((answer) => answer.questionId));
  if (answers.length !== request.questions.length) invalid();
  return { answers };
}

export function parseAgentQuestionRequest(value: unknown): AgentQuestionRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const status = (value as Record<string, unknown>).status;
  if (status !== "pending" && status !== "answered" && status !== "cancelled" && status !== "expired")
    return invalid();
  const fields = ["id", "taskId", "provider", "questions", "status"];
  const item = record(value, status === "answered" ? [...fields, "answers"] : fields);
  if (item.provider !== "codex" && item.provider !== "claudeCode") invalid();
  const questions = array(item.questions, MAX_AGENT_QUESTIONS).map(parseQuestion);
  if (!questions.length) invalid();
  unique(questions.map((question) => question.id));
  const base: AgentQuestionRequestBase = { id: id(item.id), taskId: id(item.taskId), provider: item.provider, questions };
  if (status === "answered") {
    const { answers } = parseAgentQuestionResponse({ answers: item.answers }, base);
    return { ...base, status, answers };
  }
  return { ...base, status };
}
