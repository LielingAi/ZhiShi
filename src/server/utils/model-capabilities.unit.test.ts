import { describe, expect, it } from 'vitest';

import { parseLiteLLMCatalog } from './model-capabilities';

// #1 recurring red line: a >=1M-context model MUST be tagged `[1m]` before it
// reaches SDK ingress, or the SDK silently falls back to the 200K window
// (/context shows 200K, auto-compact fires at ~187K, attachments truncate).
// applyContextWindowSuffix is the single chokepoint. These lock its contract.
//
// Threshold cases lean on bundled PRESET_PROVIDERS (always ingested into the
// registry): claude-opus-4-7 = 1_000_000, claude-sonnet-4-6 = 200_000.
describe('parseLiteLLMCatalog', () => {
  it('maps max_input_tokens → contextLength and max_output_tokens, tagging source=litellm', () => {
    const m = parseLiteLLMCatalog({
      'gpt-4o': { max_input_tokens: 128000, max_output_tokens: 16384, max_tokens: 16384, litellm_provider: 'openai', mode: 'chat' },
    });
    expect(m.get('gpt-4o')).toEqual({ contextLength: 128000, maxOutputTokens: 16384, source: 'litellm' });
  });

  it('falls back to max_tokens when max_input_tokens is absent', () => {
    const m = parseLiteLLMCatalog({ 'weird-model': { max_tokens: 32000, mode: 'chat' } });
    expect(m.get('weird-model')?.contextLength).toBe(32000);
  });

  it('skips the sample_spec doc entry', () => {
    const m = parseLiteLLMCatalog({
      sample_spec: { max_input_tokens: 999999, max_output_tokens: 1, mode: 'chat' },
      'real-model': { max_input_tokens: 8000, mode: 'chat' },
    });
    expect(m.has('sample_spec')).toBe(false);
    expect(m.get('real-model')?.contextLength).toBe(8000);
  });

  it('filters out non-LLM modes (image_generation / embedding / audio_*) — they would poison the registry', () => {
    const m = parseLiteLLMCatalog({
      '1024-x-1024/50-steps/bedrock/amazon.nova-canvas-v1:0': { max_input_tokens: 2600, mode: 'image_generation' },
      'text-embedding-3-large': { max_input_tokens: 8191, mode: 'embedding' },
      'whisper-1': { max_input_tokens: 0, mode: 'audio_transcription' },
      'gpt-4o': { max_input_tokens: 128000, mode: 'chat' },
    });
    expect(m.has('amazon.nova-canvas-v1:0')).toBe(false);
    expect(m.has('text-embedding-3-large')).toBe(false);
    expect(m.has('whisper-1')).toBe(false);
    expect(m.get('gpt-4o')?.contextLength).toBe(128000);
  });

  it('keeps entries with no mode (some valid text models omit it)', () => {
    const m = parseLiteLLMCatalog({ 'no-mode-model': { max_input_tokens: 65536, max_output_tokens: 8192 } });
    expect(m.get('no-mode-model')?.contextLength).toBe(65536);
  });

  it('indexes provider/model keys under both the full key and the provider-stripped tail', () => {
    const m = parseLiteLLMCatalog({
      'deepseek/deepseek-chat': { max_input_tokens: 131072, max_output_tokens: 8192, mode: 'chat' },
    });
    expect(m.get('deepseek/deepseek-chat')?.contextLength).toBe(131072);
    expect(m.get('deepseek-chat')?.contextLength).toBe(131072); // bare id our presets use
  });

  it('a literal key always beats a provider/model tail collision, regardless of entry order', () => {
    // provider/model listed BEFORE the literal
    const a = parseLiteLLMCatalog({
      'azure/gpt-4': { max_input_tokens: 100, mode: 'chat' },
      'gpt-4': { max_input_tokens: 8192, mode: 'chat' },
    });
    expect(a.get('gpt-4')?.contextLength).toBe(8192); // literal wins, not the 100 tail
    // literal listed BEFORE provider/model
    const b = parseLiteLLMCatalog({
      'gpt-4': { max_input_tokens: 8192, mode: 'chat' },
      'azure/gpt-4': { max_input_tokens: 100, mode: 'chat' },
    });
    expect(b.get('gpt-4')?.contextLength).toBe(8192); // still the literal
  });

  it('skips entries with neither a context window nor an output limit', () => {
    const m = parseLiteLLMCatalog({ 'pricing-only': { input_cost_per_token: 0.0001, mode: 'chat' } });
    expect(m.has('pricing-only')).toBe(false);
  });

  it('is robust to non-object / null inputs', () => {
    expect(parseLiteLLMCatalog(null).size).toBe(0);
    expect(parseLiteLLMCatalog('nope').size).toBe(0);
    expect(parseLiteLLMCatalog({ x: null, y: 42, z: 'str' }).size).toBe(0);
  });
});
