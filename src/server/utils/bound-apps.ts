/**
 * AppCraft (PRD 0.2.36 §6.1) — server-side resolution of a workspace's bound
 * applications.
 *
 * Bound apps live on `Project.boundApps` in projects.json (written by the
 * renderer config services — transparent JSON persistence, no server-side
 * write path). The sidecar reads them at session start to:
 *
 *   1. inject `CUSE_BOUND_APPS` into the bundled cuse MCP subprocess env
 *      (agent-session.ts `buildSdkMcpServers`, Pattern 3 stdio branch), and
 *   2. inject a `<zhishi-bound-apps>` section into the system prompt append
 *      (system-prompt.ts), and
 *   3. widen the SDK session's accessible directories with each app's
 *      `dataDir` (`additionalDirectories` query option).
 *
 * All three consumers share this module so "which apps count" has exactly one
 * definition: the project's `boundApps` filtered to `enabled === true`,
 * matched by canonical workspace-path identity (separator/case tolerant —
 * the same mismatch class as #320).
 */

import type { BoundApp } from '../../shared/config-types';
import { normalizeWorkspacePathIdentity } from '../../shared/workspacePath';
import { loadProjects } from './admin-config';

/**
 * Return the enabled bound apps for the workspace at `workspacePath`.
 * Returns [] when the path is empty, no project matches, the project has no
 * boundApps, or every app is disabled — callers treat [] as "zero injection".
 */
export function getEnabledBoundAppsForWorkspace(workspacePath: string): BoundApp[] {
  if (!workspacePath) return [];
  const identity = normalizeWorkspacePathIdentity(workspacePath);
  if (!identity) return [];
  const project = loadProjects().find(
    (p) => typeof p.path === 'string' && normalizeWorkspacePathIdentity(p.path) === identity,
  );
  if (!project?.boundApps || !Array.isArray(project.boundApps)) return [];
  // Defensive shape check: projects.json is user-editable; a malformed entry
  // must not reach the cuse env / system prompt.
  return project.boundApps.filter(
    (a): a is BoundApp =>
      !!a &&
      typeof a === 'object' &&
      typeof a.id === 'string' &&
      typeof a.name === 'string' &&
      typeof a.exe === 'string' &&
      typeof a.windowTitle === 'string' &&
      a.enabled === true,
  );
}

/**
 * dataDir values of the enabled bound apps — the extra directories the agent
 * is allowed to read/write beyond the workspace root (SDK
 * `additionalDirectories`). Missing/empty dataDir entries are skipped.
 */
export function getEnabledBoundAppDataDirs(workspacePath: string): string[] {
  return getEnabledBoundAppsForWorkspace(workspacePath)
    .map((a) => a.dataDir)
    .filter((d): d is string => typeof d === 'string' && d.trim().length > 0);
}
