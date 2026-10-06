import type { AgentApprovalDecision, AgentApprovalRequest } from '../domain/approvals.js';

export interface ApprovalRepository {
  createApproval(request: AgentApprovalRequest): Promise<AgentApprovalRequest>;
  listApprovals(taskId: string): Promise<readonly AgentApprovalRequest[]>;
  answerApproval(taskId: string, id: string, decision: AgentApprovalDecision): Promise<AgentApprovalRequest>;
  timeoutApproval(taskId: string, id: string): Promise<boolean>;
  settleApproval(taskId: string, id: string, status: 'cancelled'): Promise<void>;
  expireApprovals(taskId?: string): Promise<void>;
}
