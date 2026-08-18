/**
 * ToolAttachment — 工具产物（图片/音频/PDF/文件）一等公民通道。
 *
 * 由 Sidecar 落盘后通过 UnifiedEvent.tool_result.attachments[] 送达前端，
 * 前端通过 ToolAttachmentGallery 统一渲染。任意 Runtime（builtin / Codex /
 * Gemini / CC）+ 任意工具的图片产物都走这条通道，不再"按工具名前缀分发到
 * 专门 React 组件"。
 *
 * 详见 specs/prd/prd_0.2.15_codex_tool_outputs_normalization.md。
 */

export type ToolAttachmentKind = 'image' | 'audio' | 'pdf' | 'file';

export interface ToolAttachment {
  kind: ToolAttachmentKind;

  /** MIME 类型，如 'image/png' / 'audio/mpeg' / 'application/pdf' */
  mimeType: string;

  /**
   * **相对**路径形态。形如 `/api/attachment/tool/<sessionId>/<turnId>/<filename>`，
   * 前端运行时拼当前 sidecar base URL — Tab/Session sidecar 端口 dynamic，
   * 落盘绝对 URL 在 session resume 后端口已变，老 URL 全坏。
   */
  refPath: string;

  /**
   * 落盘绝对路径，**仅在 Tauri 桌面 sidecar 写**（沿用 sessionOwner sidecar 信任根，
   * 通过 `cmd_read_attachment_base64` 读取时仍需反查 SessionStore 校验三元组）。
   * IM Bot / Cron Sidecar 不写此字段，强制走 refPath HTTP 路径避免跨 sidecar 直读。
   */
  savedPath?: string;

  /**
   * 原始产物路径（PRD 0.2.31）。`savedPath` 是 trusted-root 的**副本**（用于渲染/重启可解析）；
   * `sourcePath` 是工具实际写出的**原始**文件（如 `~/.zhishi/generated_audio/xxx.mp3`），
   * 也是工具卡 meta 展示的那条路径。「在文件管理器中显示 / 用默认应用打开」优先用它，
   * 让"看到的路径"和"打开的路径"一致。仅 builtin 媒体附件设置；其它来源留空。
   */
  sourcePath?: string;

  sizeBytes?: number;

  /** 图片像素宽（如已知） */
  width?: number;

  /** 图片像素高（如已知） */
  height?: number;

  /**
   * 工具产物描述。**字符串硬上限 4KB**——防 unbounded 入侵 SSE 256KB 红线。
   * 如 OpenAI image_generation 的 revisedPrompt、edge-tts 的合成文本。
   */
  caption?: string;

  /** 调试/审计：来源工具标识。如 'codex.image_generation' / 'mcp.gemini-image.generate_image'。 */
  producedBy?: string;

  /**
   * Placeholder 模式：base64 落盘异步进行时先 emit 占位 attachment，落盘成功后
   * 通过 `chat:tool-attachment-update` SSE 事件 patch 填充 refPath/savedPath/sizeBytes。
   * 前端识别该字段，渲染 loading 骨架直到 patch 抵达。
   */
  pendingId?: string;
}

/** 占位 attachment 的硬性最大字节数（25MB，对齐 workspace_files download 红线）。 */
export const MAX_TOOL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** caption 字符串硬上限（4KB）。 */
export const MAX_TOOL_ATTACHMENT_CAPTION_BYTES = 4 * 1024;
