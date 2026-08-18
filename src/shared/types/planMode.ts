/**
 * PlanMode types - shared between frontend and backend
 * For ExitPlanMode and EnterPlanMode SDK tool interception
 */

export interface ExitPlanModeAllowedPrompt {
  tool: 'Bash';
  prompt: string;
}

export interface ExitPlanModeRequest {
  requestId: string;
  plan?: string;
  allowedPrompts?: ExitPlanModeAllowedPrompt[];
  resolved?: 'approved' | 'rejected';
}

/**
 * POST /api/exit-plan-mode/respond payload.
 * `feedback` (issue #182): user's optional 「修改意见」 — only meaningful on
 * rejection. When non-empty, the SDK forwards it to the model via deny.message
 * with `interrupt: false`, so the AI can revise the plan in the same turn.
 */
export interface ExitPlanModeResponse {
  requestId: string;
  approved: boolean;
  feedback?: string;
}

export interface EnterPlanModeRequest {
  requestId: string;
  resolved?: 'approved' | 'rejected';
  autoApproved?: boolean; // SDK auto-allowed EnterPlanMode (no user confirmation needed)
}
