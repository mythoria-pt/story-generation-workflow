import { getTTSHttpError, TTSGenerationError } from '@/services/tts-errors.js';

describe('TTS error HTTP mapping', () => {
  it('exposes a retryable upstream Gemini failure without leaking details', () => {
    const error = new TTSGenerationError('Gemini TTS returned no audio data', {
      code: 'GEMINI_TTS_EMPTY_AUDIO',
      statusCode: 502,
      retryable: true,
      details: { responseId: 'response-1', transcript: 'must-not-leak' },
    });

    expect(getTTSHttpError(error)).toEqual({
      statusCode: 502,
      body: {
        success: false,
        code: 'GEMINI_TTS_EMPTY_AUDIO',
        retryable: true,
        error: 'Gemini TTS returned no audio data',
      },
    });
  });

  it('marks FFmpeg capability failures as non-retryable dependencies', () => {
    const error = new TTSGenerationError('Background music mixing failed', {
      code: 'FFMPEG_MIX_FAILED',
      statusCode: 424,
      retryable: false,
    });

    expect(getTTSHttpError(error)).toMatchObject({
      statusCode: 424,
      body: {
        code: 'FFMPEG_MIX_FAILED',
        retryable: false,
      },
    });
  });
});
