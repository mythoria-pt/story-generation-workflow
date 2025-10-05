/**
 * Centralised model token/output limits.
 * Values based on publicly available provider documentation (Sept 2025) and widely reported defaults.
 * If a model isn't listed we fall back to a conservative default (8192 output tokens).
 * NOTE: Keep this file updated as providers raise limits.
 */

interface ModelLimits {
  maxOutputTokens: number; // per single response candidate
}

// Heuristic / documented limits (output token caps, not context window sizes)
const LIMITS: Record<string, ModelLimits> = {
  // Google Gemini 2.5 family (Flash / Pro) – typical output cap 8k tokens
  'gemini-2.5-flash': { maxOutputTokens: 65536 },
  'gemini-2.5-pro': { maxOutputTokens: 65536 },
  'gemini-2.5-flash-lite': { maxOutputTokens: 65536 },
  // Image preview model still returns textual prompt refinements / JSON; use same cap
  'gemini-2.5-flash-image-preview': { maxOutputTokens: 32768 },
  // Legacy 2.0 (kept for safety)
  'gemini-2.0-flash': { maxOutputTokens: 8192 },
  // OpenAI GPT‑5 family (assumed: base 16k, mini 8k, nano 4k output cap)
  'gpt-5': { maxOutputTokens: 128000 },
  'gpt-5-mini': { maxOutputTokens: 128000 },
  'gpt-5-nano': { maxOutputTokens: 128000 },
};

const DEFAULT_OUTPUT_MAX = 32768;

export function getMaxOutputTokens(model: string | undefined): number {
  if (!model) return DEFAULT_OUTPUT_MAX;
  const key = model.toLowerCase();
  return LIMITS[key]?.maxOutputTokens ?? DEFAULT_OUTPUT_MAX;
}

export function describeModelLimit(model: string | undefined) {
  return { model, appliedMaxOutputTokens: getMaxOutputTokens(model) };
}
