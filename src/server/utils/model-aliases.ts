export type ModelAliases = {
  sonnet?: string;
  opus?: string;
  haiku?: string;
};

/**
 * Third-party provider aliases serve two different purposes:
 *
 * - Split tables (`sonnet`/`opus`/`haiku` point at different models) are an
 *   intentional routing policy and must be preserved.
 * - Collapsed tables (all three aliases point at the same model) are just a
 *   safety net to stop SDK built-in subagents from leaking raw Claude model IDs
 *   to third-party providers. In that case the active session model is the
 *   user's real choice and should drive SDK aliases too.
 */
export function resolveSessionModelAliases(
  aliases: ModelAliases | undefined,
  activeModel: string | undefined | null,
): ModelAliases | undefined {
  const model = activeModel?.trim();
  if (!aliases || !model) return aliases;
  if (!aliases.sonnet || !aliases.opus || !aliases.haiku) return aliases;
  if (aliases.sonnet !== aliases.opus || aliases.opus !== aliases.haiku) return aliases;
  if (aliases.haiku === model) return aliases;
  return { sonnet: model, opus: model, haiku: model };
}
