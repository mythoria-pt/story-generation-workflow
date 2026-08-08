export type TTSGenerationErrorCode =
  | 'GEMINI_TTS_EMPTY_AUDIO'
  | 'GEMINI_TTS_BLOCKED'
  | 'GEMINI_TTS_MAX_TOKENS'
  | 'FFMPEG_MIX_FAILED'
  | 'BACKGROUND_MUSIC_UNAVAILABLE';

interface TTSGenerationErrorOptions {
  code: TTSGenerationErrorCode;
  statusCode: number;
  retryable: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class TTSGenerationError extends Error {
  readonly code: TTSGenerationErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, options: TTSGenerationErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TTSGenerationError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable;
    this.details = options.details;
  }
}

export function isTTSGenerationError(error: unknown): error is TTSGenerationError {
  return error instanceof TTSGenerationError;
}

export function getTTSHttpError(error: unknown): {
  statusCode: number;
  body: {
    success: false;
    code?: TTSGenerationErrorCode;
    retryable?: boolean;
    error: string;
  };
} {
  if (isTTSGenerationError(error)) {
    return {
      statusCode: error.statusCode,
      body: {
        success: false,
        code: error.code,
        retryable: error.retryable,
        error: error.message,
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    },
  };
}
