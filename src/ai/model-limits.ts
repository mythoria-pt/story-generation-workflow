/** Default request ceilings. Hydrogen long-decode budgets are configured per story operation. */

interface ModelLimits {
  maxOutputTokens: number; // per single response candidate
}

// Request defaults; the Hydrogen adapter separately enforces its unified context limit.
const LIMITS: Record<string, ModelLimits> = {
  'gemini-4-hydrogen': { maxOutputTokens: 65536 },
  // Image preview model still returns textual prompt refinements / JSON; use same cap
  'gemini-2.5-flash-image-preview': { maxOutputTokens: 32768 },
  'gemini-3.1-flash-image': { maxOutputTokens: 32768 },
  'gemini-nano-banana-2.1': { maxOutputTokens: 32768 },
  'gemini-3-pro-image-preview': { maxOutputTokens: 32768 },
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
