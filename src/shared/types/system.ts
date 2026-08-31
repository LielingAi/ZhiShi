export type SystemInitInfo = {
  timestamp: string;
  type?: string;
  subtype?: string;
  cwd?: string;
  session_id?: string;
  tools?: string[];
  // 协议镜像字段：与 Claude Code system-init 事件的字段形状保持一致，
  // 当前无生产/消费代码路径，刻意保留（删除收益低，见 1.5.4 审计 B7）。
  mcp_servers?: string[];
  model?: string;
  permissionMode?: string;
  slash_commands?: string[];
  apiKeySource?: string;
  claude_code_version?: string;
  output_style?: string;
  agents?: string[];
  skills?: string[];
  plugins?: string[];
  uuid?: string;
};
