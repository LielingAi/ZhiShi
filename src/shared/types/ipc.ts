export interface SuccessResponse {
  success: boolean;
  error?: string;
}

export type ChatModelPreference = 'fast' | 'smart-sonnet' | 'smart-opus';
export type SmartModelVariant = 'sonnet' | 'opus';

export interface SerializedAttachmentPayload {
  name: string;
  mimeType: string;
  size: number;
  data: ArrayBuffer | Uint8Array;
}

export interface SendMessagePayload {
  text: string;
  attachments?: SerializedAttachmentPayload[];
  /** Model ID to use for this message (e.g., 'claude-sonnet-4-6') */
  model?: string;
  /** Permission mode to use for this message */
  permissionMode?: 'auto' | 'plan' | 'fullAgency' | 'custom';
  /** Background-agent permission policy (#264); echoed from global AppConfig. */
  backgroundAgentPermissionMode?: 'inherit' | 'fullAgency';
  /** Provider environment variables (baseUrl, apiKey, authType) for third-party providers */
  providerEnv?: {
    baseUrl?: string;
    apiKey?: string;
    authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
    apiProtocol?: 'anthropic' | 'openai';
    /** Max output tokens cap for OpenAI bridge (only used when apiProtocol === 'openai') */
    maxOutputTokens?: number;
    /** Parameter name for token limit sent to upstream. Default 'max_tokens'. */
    maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
    /** Upstream API format for OpenAI bridge (only used when apiProtocol === 'openai') */
    upstreamFormat?: 'chat_completions' | 'responses';
  };
}

export interface SavedAttachmentInfo {
  name: string;
  mimeType: string;
  size: number;
  savedPath: string;
  relativePath: string;
}

export interface SendMessageResponse {
  success: boolean;
  error?: string;
  attachments?: SavedAttachmentInfo[];
  queued?: boolean;   // true if message was queued (AI was busy)
  queueId?: string;   // queue item ID when queued
}

