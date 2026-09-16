import type { AgentQuestionRequest, AgentQuestionResponse } from '../domain/questions.js';

export interface QuestionRepository {
  createQuestion(request: AgentQuestionRequest): Promise<AgentQuestionRequest>;
  listQuestions(taskId: string): Promise<readonly AgentQuestionRequest[]>;
  answerQuestion(taskId: string, id: string, response: AgentQuestionResponse): Promise<AgentQuestionRequest>;
  expireQuestions(taskId?: string): Promise<void>;
}
