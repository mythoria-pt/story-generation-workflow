/**
 * Custom AI Error Types
 */

export interface ProviderDiagnostic {
  idx?: number;
  finishReason?: string;
  hasContent?: boolean;
  partCount?: number;
  [key: string]: unknown;
}

/**
 * Error thrown when an image generation request is blocked by provider safety / policy filters.
 * This lets upstream formatters enrich HTTP responses & workflow error surfaces.
 */
export class ImageGenerationBlockedError extends Error {
  public code = 'IMAGE_SAFETY_BLOCKED';
  public provider: string;
  public providerFinishReasons: string[];
  public diagnostics?: ProviderDiagnostic[];
  public category = 'safety_blocked';
  public retryable = false; // Prompt needs modification, not a transient error
  public suggestions: string[];

  constructor(params: {
    provider: string;
    finishReasons: string[];
    diagnostics?: ProviderDiagnostic[];
    message?: string;
    suggestions?: string[];
  }) {
    const reasonStr = params.finishReasons.join(', ');
    super(
      params.message ||
        `Image generation blocked by ${params.provider} safety filters (reason(s): ${reasonStr}).`,
    );
    this.name = 'ImageGenerationBlockedError';
    this.provider = params.provider;
    this.providerFinishReasons = params.finishReasons;
    if (params.diagnostics) this.diagnostics = params.diagnostics;
    this.suggestions = params.suggestions || [
      'Remove potentially sensitive or disallowed content (violence, explicit detail, self‑harm, identifying minors).',
      'Focus on neutral, descriptive visual attributes (setting, colors, composition) instead of graphic specifics.',
      'Avoid mentioning age alongside sensitive contexts; describe general appearance instead.',
      'Eliminate subjective or potentially sexualized descriptors for minors or ambiguous characters.',
      'Try a milder synonym or remove emotionally charged words that might trigger safety filters.',
    ];
  }
}

/**
 * Error thrown when Google Gemini returns IMAGE_OTHER finish reason.
 * This is an ambiguous signal: may be a transient hiccup or a soft safety block.
 * Treated as transient-retryable first, then re-classified as a safety block if it persists.
 */
export class ImageOtherError extends Error {
  public code = 'IMAGE_OTHER';
  public provider: string;
  public finishReasons: string[];
  public diagnostics?: ProviderDiagnostic[];
  public retryable = true; // Retry once as transient before treating as safety

  constructor(params: {
    provider: string;
    finishReasons: string[];
    diagnostics?: ProviderDiagnostic[];
    message?: string;
  }) {
    const reasonStr = params.finishReasons.join(', ');
    super(
      params.message ||
        `Image generation returned ambiguous result from ${params.provider} (reason(s): ${reasonStr}). May be transient or a soft safety block.`,
    );
    this.name = 'ImageOtherError';
    this.provider = params.provider;
    this.finishReasons = params.finishReasons;
    if (params.diagnostics) this.diagnostics = params.diagnostics;
  }

  /**
   * Convert this ambiguous error into a definitive ImageGenerationBlockedError
   * (used after transient retries are exhausted).
   */
  toBlockedError(): ImageGenerationBlockedError {
    return new ImageGenerationBlockedError({
      provider: this.provider,
      finishReasons: this.finishReasons,
      ...(this.diagnostics ? { diagnostics: this.diagnostics } : {}),
      message: `Image generation blocked by ${this.provider} (reason: ${this.finishReasons.join(',')}). Transient retries exhausted; treating as safety block.`,
    });
  }
}
