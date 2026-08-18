// Agent architecture types (v0.1.41)
// Agent = upgraded workspace with pluggable I/O channels

// ── Legacy IM channel shapes ─────────────────────────────────────────────
// The IM channel system (bots, heartbeat, group permissions) was removed in
// the security-researcher CLI transition. These type definitions remain only
// because AgentConfig / ChannelConfig persist them on disk; nothing schedules
// heartbeats or opens channels anymore.

/** IM platform type (legacy — channels are no longer started) */
export type ImPlatform = 'telegram' | 'feishu' | 'dingtalk' | `openclaw:${string}`;

/** Group activation mode (legacy) */
export type GroupActivation = 'mention' | 'always';

export type GroupPermissionStatus = 'pending' | 'approved';

/** Group chat permission record (legacy) */
export interface GroupPermission {
  groupId: string;
  groupName: string;
  platform: ImPlatform;
  status: GroupPermissionStatus;
  discoveredAt: string;
  addedBy?: string;
}

/** Heartbeat configuration (legacy — no scheduler consumes it anymore) */
export interface HeartbeatConfig {
  /** Enable/disable heartbeat (default: true) */
  enabled: boolean;
  /** Interval in minutes between heartbeat checks (default: 30, min: 5) */
  intervalMinutes: number;
  /** Active hours window — heartbeat only fires within this window */
  activeHours?: ActiveHoursConfig;
  /** Max chars for HEARTBEAT_OK detection after stripping token (default: 300) */
  ackMaxChars?: number;
}

/** Active hours window for heartbeat scheduling (legacy) */
export interface ActiveHoursConfig {
  /** Start time in HH:MM format (inclusive) */
  start: string;
  /** End time in HH:MM format (exclusive) */
  end: string;
  /** IANA timezone name (default: "Asia/Shanghai") */
  timezone: string;
}

import type { RuntimeType, RuntimeConfig } from './runtime';

/**
 * Channel type — reuses ImPlatform, not redefined
 */
export type ChannelType = ImPlatform;

/**
 * Last active channel tracking for heartbeat/cron routing
 */
export interface LastActiveChannel {
  channelId: string;
  sessionKey: string;
  lastActiveAt: string; // ISO timestamp
}

/**
 * Channel-level config overrides (empty = inherit from Agent)
 */
export interface ChannelOverrides {
  providerId?: string;
  providerEnvJson?: string;
  model?: string;
  permissionMode?: string;
  toolsDeny?: string[];
}

/**
 * Channel configuration — a single I/O endpoint within an Agent
 */
export interface ChannelConfig {
  // Identity
  id: string;
  type: ChannelType;
  name?: string;           // Defaults to platform display name
  /** 平台显示名（群里成员实际看到并 @ 的名字）。设置后 IM 提示词里的
   *  botName 用它而非 name——解决配置名与平台名不一致时 AI 认不出
   *  「群友在叫自己」的问题（PRD 0.2.37 已知问题#3，2026-08-06）。 */
  platformDisplayName?: string;
  enabled: boolean;

  // Platform credentials (vary by type)
  botToken?: string;
  telegramUseDraft?: boolean;

  feishuAppId?: string;
  feishuAppSecret?: string;

  dingtalkClientId?: string;
  dingtalkClientSecret?: string;
  dingtalkUseAiCard?: boolean;
  dingtalkCardTemplateId?: string;

  // OpenClaw Plugin
  openclawPluginId?: string;
  openclawNpmSpec?: string;
  openclawPluginConfig?: Record<string, string>;
  openclawManifest?: Record<string, string>;
  /** Enabled tool groups for OpenClaw plugins with tools (e.g. feishu) */
  openclawEnabledToolGroups?: string[];

  // User management
  allowedUsers?: string[];

  // Group chat
  groupPermissions?: GroupPermission[];
  groupActivation?: GroupActivation;

  // Optional overrides (empty/undefined = inherit from Agent)
  overrides?: ChannelOverrides;

  // Runtime
  setupCompleted?: boolean;
}

/**
 * Agent configuration — an upgraded workspace with AI config and channels
 */
export interface AgentConfig {
  // Identity
  id: string;
  name: string;
  icon?: string;           // Phosphor icon ID or emoji
  enabled: boolean;

  // Core: Workspace
  workspacePath: string;

  // AI Configuration (defaults for all channels)
  providerId?: string;
  model?: string;
  providerEnvJson?: string;
  permissionMode: string;  // 'plan' | 'auto' | 'fullAgency'
  mcpEnabledServers?: string[];
  /** Resolved MCP server definitions JSON (persisted for auto-start, rebuilt on manual start) */
  mcpServersJson?: string;
  /** PRD 0.2.17 — Claude plugins enabled for this Agent (subset of globally
   *  visible plugins; gated by AppConfig.enabledPlugins). Sessions started from
   *  this Agent inherit this list as their initial selection; per-Tab UI can
   *  override transiently. Mirrors mcpEnabledServers semantics exactly. */
  enabledPluginIds?: string[];

  // Heartbeat (Agent-level, shared across channels)
  heartbeat?: HeartbeatConfig;

  // Channels
  channels: ChannelConfig[];

  // Active message routing
  lastActiveChannel?: LastActiveChannel;

  // Agent Runtime (v0.1.59)
  runtime?: RuntimeType;           // 'builtin' | 'claude-code' | 'codex', defaults to 'builtin'
  runtimeConfig?: RuntimeConfig;   // Runtime-specific model/permission/args

  // Runtime
  setupCompleted?: boolean;
}

/**
 * Resolve effective config for a channel by merging Agent defaults with Channel overrides
 */
export function resolveEffectiveConfig(agent: AgentConfig, channel: ChannelConfig) {
  return {
    providerId: channel.overrides?.providerId ?? agent.providerId,
    providerEnvJson: channel.overrides?.providerEnvJson ?? agent.providerEnvJson,
    model: channel.overrides?.model ?? agent.model,
    permissionMode: channel.overrides?.permissionMode ?? agent.permissionMode,
    mcpEnabledServers: agent.mcpEnabledServers,      // Channel cannot override
    enabledPluginIds: agent.enabledPluginIds,        // Channel cannot override (mirrors MCP)
    toolsDeny: channel.overrides?.toolsDeny ?? [],
    workspacePath: agent.workspacePath,               // Always Agent's
    heartbeat: agent.heartbeat,                       // Always Agent's
    runtime: agent.runtime ?? 'builtin',
    runtimeConfig: agent.runtimeConfig,
  };
}
