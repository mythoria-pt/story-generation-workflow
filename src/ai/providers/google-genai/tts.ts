/**
 * Google Gemini TTS (Text-to-Speech) Provider
 * Implements ITTSService for Google's Gemini TTS API.
 *
 * Note: Gemini TTS outputs raw PCM audio at 24kHz, 16-bit, mono.
 * This provider converts PCM to MP3 using fluent-ffmpeg.
 */

import { FinishReason, GenerateContentResponse, GoogleGenAI } from '@google/genai';
import { ITTSService, TTSOptions, TTSResult, TTSProvider } from '../../interfaces.js';
import { logger } from '@/config/logger.js';
import { isTransientError, withRetry } from '@/shared/retry-utils.js';
import { FFMPEG_BINARY } from '@/config/ffmpeg.js';
import { TTSGenerationError, isTTSGenerationError } from '@/services/tts-errors.js';
import ffmpeg from 'fluent-ffmpeg';
import { Readable, PassThrough } from 'stream';

ffmpeg.setFfmpegPath(FFMPEG_BINARY);

const NON_RETRYABLE_FINISH_REASONS = new Set<FinishReason>([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.LANGUAGE,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
]);

interface GeminiAudioResponse {
  pcmBuffer: Buffer;
  metadata: Record<string, unknown>;
}

function summarizeGeminiResponse(response: GenerateContentResponse): Record<string, unknown> {
  const candidates = response.candidates ?? [];
  const parts = candidates.flatMap((candidate) => candidate.content?.parts ?? []);

  return {
    responseId: response.responseId,
    modelVersion: response.modelVersion,
    promptBlockReason: response.promptFeedback?.blockReason,
    promptBlockReasonMessage: response.promptFeedback?.blockReasonMessage,
    candidateCount: candidates.length,
    finishReasons: candidates.map((candidate) => candidate.finishReason).filter(Boolean),
    finishMessages: candidates.map((candidate) => candidate.finishMessage).filter(Boolean),
    partTypes: parts.map((part) => {
      if (part.inlineData) return 'inlineData';
      if (typeof part.text === 'string') return 'text';
      return 'other';
    }),
    inlineMimeTypes: parts.map((part) => part.inlineData?.mimeType).filter(Boolean),
    usageMetadata: response.usageMetadata,
  };
}

function extractGeminiAudio(response: GenerateContentResponse): GeminiAudioResponse {
  const metadata = summarizeGeminiResponse(response);
  const candidates = response.candidates ?? [];
  const finishReasons = candidates
    .map((candidate) => candidate.finishReason)
    .filter((reason): reason is NonNullable<typeof reason> => reason !== undefined);
  const blockReason = response.promptFeedback?.blockReason;

  if (blockReason || finishReasons.some((reason) => NON_RETRYABLE_FINISH_REASONS.has(reason))) {
    throw new TTSGenerationError('Gemini TTS rejected the speech generation request', {
      code: 'GEMINI_TTS_BLOCKED',
      statusCode: 422,
      retryable: false,
      details: metadata,
    });
  }

  if (finishReasons.includes(FinishReason.MAX_TOKENS)) {
    throw new TTSGenerationError('Gemini TTS reached the output token limit', {
      code: 'GEMINI_TTS_MAX_TOKENS',
      statusCode: 422,
      retryable: false,
      details: metadata,
    });
  }

  const audioBuffers = candidates
    .map((candidate) =>
      (candidate.content?.parts ?? []).flatMap((part) => {
        const data = part.inlineData?.data;
        const mimeType = part.inlineData?.mimeType;
        if (!data || (mimeType && !mimeType.startsWith('audio/'))) {
          return [];
        }
        return [Buffer.from(data, 'base64')];
      }),
    )
    .find((buffers) => buffers.length > 0);

  if (!audioBuffers) {
    throw new TTSGenerationError('Gemini TTS returned no audio data', {
      code: 'GEMINI_TTS_EMPTY_AUDIO',
      statusCode: 502,
      retryable: true,
      details: metadata,
    });
  }

  return {
    pcmBuffer: Buffer.concat(audioBuffers),
    metadata,
  };
}

function extractGeminiErrorDetails(error: unknown): Record<string, unknown> {
  const details: Record<string, unknown> = {
    errorType: typeof error,
  };

  if (error instanceof Error) {
    details.name = error.name;
    details.message = error.message;
    details.stack = error.stack;
  }

  if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, unknown>;
    const status =
      (err.status as unknown) ??
      (err.statusCode as unknown) ??
      (err.code as unknown) ??
      (err.error as { code?: unknown } | undefined)?.code;

    if (status !== undefined) {
      details.status = status;
    }

    if (err.error !== undefined) {
      details.serviceError = err.error;
    }

    if (err.details !== undefined) {
      details.details = err.details;
    }

    if (err.response !== undefined) {
      details.response = err.response;
    }

    if (typeof err.message === 'string') {
      const trimmed = err.message.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          details.parsedMessage = JSON.parse(trimmed);
        } catch {
          details.parsedMessage = 'unparseable-json';
        }
      }
    }
  }

  return details;
}

export interface GoogleGenAITTSConfig {
  apiKey: string;
  model?: string | undefined;
  defaultVoice?: string | undefined;
  defaultSpeed?: number | undefined;
}

/**
 * Curated Google Gemini TTS voices for storytelling
 * Selected 8 voices with diverse characteristics suitable for audiobooks
 */
export const GEMINI_TTS_VOICES = [
  'Charon', // Informative - good for narration (DEFAULT)
  'Aoede', // Breezy - light and pleasant
  'Puck', // Upbeat - energetic delivery
  'Kore', // Firm - confident and clear
  'Fenrir', // Excitable - dynamic storytelling
  'Orus', // Firm - authoritative
  'Zephyr', // Bright - cheerful tone
  'Sulafat', // Warm - comfortable and inviting
] as const;

export type GeminiTTSVoice = (typeof GEMINI_TTS_VOICES)[number];

/**
 * Google Gemini TTS models
 */
export const GEMINI_TTS_MODELS = [
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-pro-preview-tts',
  'gemini-2.5-flash-preview-tts',
] as const;

export type GeminiTTSModel = (typeof GEMINI_TTS_MODELS)[number];

export class GoogleGenAITTSService implements ITTSService {
  private client: GoogleGenAI;
  private model: string;
  private defaultVoice: string;

  constructor(config: GoogleGenAITTSConfig) {
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
    this.model = config.model || 'gemini-3.1-flash-tts-preview';
    this.defaultVoice = config.defaultVoice || 'Charon';
    // Note: Gemini TTS doesn't support speed parameter directly
  }

  /**
   * Convert PCM audio buffer to MP3 using ffmpeg
   */
  private async convertPcmToMp3(pcmBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      // Create a readable stream from the PCM buffer
      const inputStream = new Readable();
      inputStream.push(pcmBuffer);
      inputStream.push(null);

      // Create output stream
      const outputStream = new PassThrough();

      outputStream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      outputStream.on('end', () => {
        resolve(Buffer.concat(chunks));
      });

      outputStream.on('error', (err: unknown) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      // Convert PCM to MP3
      // Gemini TTS outputs: 24kHz, 16-bit, mono, little-endian PCM
      ffmpeg(inputStream)
        .inputFormat('s16le') // signed 16-bit little-endian
        .inputOptions(['-ar 24000', '-ac 1']) // 24kHz, mono
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .format('mp3')
        .on('error', (err: Error) => {
          logger.error('FFmpeg conversion error', {
            error: err.message,
          });
          reject(err);
        })
        .pipe(outputStream, { end: true });
    });
  }

  /**
   * Synthesize speech from text using Google Gemini TTS
   */
  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    const voice = options?.voice || this.defaultVoice;
    const model = options?.model || this.model;

    // Normalize model name to match API requirements
    let apiModel = model;
    if (model === 'gemini-3.1-flash-tts') {
      apiModel = 'gemini-3.1-flash-tts-preview';
    } else if (model === 'gemini-2.5-pro-tts') {
      apiModel = 'gemini-2.5-pro-preview-tts';
    } else if (model === 'gemini-2.5-flash-tts') {
      apiModel = 'gemini-2.5-flash-preview-tts';
    } else if (model === 'gemini-3.1-flash') {
      apiModel = 'gemini-3.1-flash-tts-preview';
    } else if (model === 'gemini-2.5-pro') {
      apiModel = 'gemini-2.5-pro-preview-tts';
    }

    const systemPrompt = options?.systemPrompt;
    const speed = options?.speed || 1.0;
    const language = options?.language;
    const chapterNumber = options?.chapterNumber;

    try {
      logger.info('Generating TTS with Google Gemini', {
        model: apiModel,
        originalModel: model,
        voice,
        textLength: text.length,
        hasSystemPrompt: !!systemPrompt,
        speed,
        language,
      });

      // Use an explicit speech-synthesis preamble so the Gemini TTS classifier
      // does not mistake the request for ordinary text generation.
      let contentText = [
        'Generate single-speaker speech from the transcript below.',
        'Speak only the transcript. Do not read the instructions or section labels.',
        'Return audio only; do not return text.',
        '',
      ].join('\n');

      // 1. Add System Prompt / Style Instructions
      if (systemPrompt) {
        // Enhance system prompt for the new model's expressive capabilities
        const enhancedSystemPrompt =
          apiModel === 'gemini-3.1-flash-tts-preview'
            ? `${systemPrompt}\n\nIMPORTANT: Use high emotional range. Honor all inline audio tags like [whispers], [laughs], [excited], and [long pause] to create a compelling performance.`
            : systemPrompt;

        contentText += `### DIRECTOR'S NOTES\n${enhancedSystemPrompt}\n`;
      }

      // 2. Add Speed Instruction if not 1.0 (Gemini TTS doesn't support speed param directly)
      if (speed !== 1.0) {
        let paceInstruction = '';
        if (speed < 0.8) paceInstruction = 'Speak very slowly and clearly.';
        else if (speed < 1.0) paceInstruction = 'Speak slightly slower than normal.';
        else if (speed > 1.2) paceInstruction = 'Speak fast and energetically.';
        else if (speed > 1.0) paceInstruction = 'Speak slightly faster than normal.';

        if (paceInstruction) {
          if (!contentText.includes("DIRECTOR'S NOTES")) {
            contentText += `### DIRECTOR'S NOTES\n`;
          }
          contentText += `Pacing: ${paceInstruction}\n`;
        }
      }

      // 3. Add Language Instruction if systemPrompt didn't cover it
      if (!systemPrompt && language) {
        if (!contentText.includes("DIRECTOR'S NOTES")) {
          contentText += `### DIRECTOR'S NOTES\n`;
        }
        contentText += `Language: Read this text in ${language}.\n`;
      }

      // 4. Add Transcript
      contentText += `\n### TRANSCRIPT\n${text}`;

      // Gemini TTS uses the generate_content API with audio response modality
      const synthesis = await withRetry(
        async (context) => {
          if (context.attempt > 1) {
            logger.warn('Retrying Gemini TTS request', {
              attempt: context.attempt,
              maxAttempts: context.maxAttempts,
              model: apiModel,
              voice,
              chapterNumber,
              textLength: text.length,
            });
          }

          const response = await this.client.models.generateContent({
            model: apiModel,
            contents: contentText,
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: voice,
                  },
                },
              },
            },
          });

          // Validate within the retry boundary. Gemini 3.1 TTS Preview can
          // occasionally return text or an empty candidate instead of audio.
          return extractGeminiAudio(response);
        },
        {
          maxAttempts: 3,
          baseDelayMs: 2000,
          maxDelayMs: 5000,
          jitterMs: 500,
          retryableErrors: (error) =>
            isTTSGenerationError(error) ? error.retryable : isTransientError(error),
        },
      );

      const pcmBuffer = synthesis.pcmBuffer;

      logger.debug('Gemini TTS synthesis successful, converting PCM to MP3', {
        model,
        voice,
        pcmBufferSize: pcmBuffer.length,
        response: synthesis.metadata,
      });

      // Convert PCM to MP3
      const mp3Buffer = await this.convertPcmToMp3(pcmBuffer);

      logger.debug('PCM to MP3 conversion complete', {
        pcmSize: pcmBuffer.length,
        mp3Size: mp3Buffer.length,
      });

      return {
        buffer: mp3Buffer,
        format: 'mp3',
        sampleRate: 24000, // Gemini TTS outputs at 24kHz
        voice,
        model: model.endsWith('-tts') ? model : `${model}-tts`, // Ensure tracking sees it as TTS
        provider: 'google-genai',
      };
    } catch (error) {
      logger.error('Google Gemini TTS synthesis failed', {
        error: error instanceof Error ? error.message : String(error),
        errorDetails: extractGeminiErrorDetails(error),
        model: apiModel,
        voice,
        chapterNumber,
        textLength: text.length,
      });
      throw error;
    }
  }

  /**
   * Get the maximum text length supported by Gemini TTS
   * Gemini 3.1 TTS quality can drift for outputs longer than a few minutes.
   * Keep each request around 400 words so chapters are synthesized in stable,
   * retryable segments and concatenated afterward.
   */
  getMaxTextLength(): number {
    return 2500;
  }

  /**
   * Get the provider identifier
   */
  getProvider(): TTSProvider {
    return 'google-genai';
  }
}
