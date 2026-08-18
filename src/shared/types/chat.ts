// M4c: Claude Agent SDK 已删除——原从 '@anthropic-ai/claude-agent-sdk/sdk-tools'
// 导入的工具入参类型改为本地结构定义(渲染面只需要可选字段的形状,宽松为
// index signature 以保持向前兼容)。
import type { ToolUse } from './stream';
import type { ToolAttachment } from './tool-attachment';

export type { ToolAttachment, ToolAttachmentKind } from './tool-attachment';

export interface BashInput { command: string; timeout?: number; description?: string; run_in_background?: boolean; [key: string]: unknown }
export interface FileReadInput { file_path: string; offset?: number; limit?: number; [key: string]: unknown }
export interface FileWriteInput { file_path: string; content: string; [key: string]: unknown }
export interface FileEditInput { file_path: string; old_string: string; new_string: string; replace_all?: boolean; [key: string]: unknown }
export interface GlobInput { pattern: string; path?: string; [key: string]: unknown }
export interface GrepInput { pattern: string; path?: string; glob?: string; type?: string; output_mode?: string; [key: string]: unknown }
export interface TodoWriteInput { todos: Array<{ content: string; status: string; activeForm?: string }>; [key: string]: unknown }
export interface AgentInput { description?: string; prompt: string; subagent_type?: string; model?: string; [key: string]: unknown }
export interface TaskCreateInput { subject?: string; description?: string; [key: string]: unknown }
export interface TaskUpdateInput { taskId?: string; status?: string; [key: string]: unknown }
export interface TaskGetInput { taskId?: string; [key: string]: unknown }
export interface TaskListInput { [key: string]: unknown }
export interface WebFetchInput { url: string; prompt?: string; [key: string]: unknown }
export interface WebSearchInput { query: string; [key: string]: unknown }
export interface NotebookEditInput { notebook_path: string; new_source?: string; cell_id?: string; [key: string]: unknown }

// Re-export SDK types with friendly names
export type ReadInput = FileReadInput;
export type WriteInput = FileWriteInput;
export type EditInput = FileEditInput;

export type ToolInput =
  | AgentInput
  | BashInput
  | ReadInput
  | WriteInput
  | EditInput
  | GlobInput
  | GrepInput
  | TodoWriteInput
  | TaskCreateInput
  | TaskUpdateInput
  | TaskGetInput
  | TaskListInput
  | WebFetchInput
  | WebSearchInput
  | NotebookEditInput;

export interface SubagentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  inputJson?: string;
  parsedInput?: ToolInput;
  result?: string;
  isLoading?: boolean;
  isError?: boolean;
  // Rich-media produced by a nested sub-agent tool. Rendered via
  // ToolAttachmentGallery, mirroring the parent tool's `attachments`.
  attachments?: ToolAttachment[];
}

export interface ToolResultMeta {
  exitCode?: number | null;
  durationMs?: number | null;
  cwd?: string;
  processId?: string | null;
  status?: string;
}

// Task 工具运行统计
export interface TaskStats {
  toolCount: number;
  inputTokens: number;
  outputTokens: number;
}

// 后台任务轮询统计
export interface BackgroundTaskStats {
  toolCount: number;
  assistantCount: number;
  userCount: number;
  progressCount: number;
  elapsed: number;  // ms, 从首行到末行时间差
}

export interface ToolUseSimple extends ToolUse {
  // Raw input as it streams in - no parsing, just accumulate the raw string
  inputJson?: string;
  // Parsed input object (populated when inputJson is complete)
  parsedInput?: ToolInput;
  // Tool result content
  result?: string;
  // Whether tool is currently executing
  isLoading?: boolean;
  // Whether tool result is an error
  isError?: boolean;
  // Whether tool was stopped by user (interrupted)
  isStopped?: boolean;
  // Whether tool failed due to error
  isFailed?: boolean;
  // Runtime-specific metadata about the completed tool result
  resultMeta?: ToolResultMeta;
  // Nested tool calls emitted by subagents (Task tool)
  subagentCalls?: SubagentToolCall[];
  // Task tool specific: start time for duration calculation
  taskStartTime?: number;
  // Task tool specific: running statistics
  taskStats?: TaskStats;
  // PRD 0.2.15 — rich-media attachments (image/audio/pdf/file) produced by the tool.
  // Rendered uniformly via ToolAttachmentGallery; orthogonal to `result` text.
  attachments?: ToolAttachment[];
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'thinking' | 'server_tool_use';
  text?: string;
  tool?: ToolUseSimple;
  thinking?: string;
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
  // Stream index for thinking blocks (to track separate thinking streams)
  thinkingStreamIndex?: number;
  // Whether this thinking block is complete (received content_block_stop)
  isComplete?: boolean;
  // Whether this block was stopped by user (interrupted)
  isStopped?: boolean;
  // Whether this block failed due to error
  isFailed?: boolean;
}

export interface MessageAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  savedPath?: string;
  relativePath?: string;
  previewUrl?: string;
  isImage?: boolean;
}

export type MessageSource = 'desktop' | `${string}_private` | `${string}_group`;

export interface MessageMetadata {
  source: MessageSource;
  sourceId?: string;
  senderName?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  timestamp: Date;
  sdkUuid?: string;  // SDK 分配的 UUID，用于 resumeSessionAt / rewindFiles
  attachments?: MessageAttachment[];
  /** Message source metadata (IM integration) */
  metadata?: MessageMetadata;
  /**
   * Transient streaming flag: true while the trailing text is the actively-streaming
   * edge (drives the Markdown tail-fade). Set when text deltas arrive, cleared on the
   * text block's content-block-stop — so the fade stops the moment the model finishes
   * the text even if the turn keeps running. Not persisted; meaningless for history.
   */
  streamingTextActive?: boolean;
}
