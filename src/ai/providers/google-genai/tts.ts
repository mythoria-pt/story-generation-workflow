/**
 * Google Gemini TTS (Text-to-Speech) Provider
 * Implements ITTSService for Google's Gemini TTS API.
 *
 * Only `gemini-3.8-flash-tts` is supported. It returns WAV (mono, 24kHz, 16-bit), which
 * this provider converts to MP3 using fluent-ffmpeg. Headerless PCM is still decoded
 * defensively.
 */

import { FinishReason, GenerateContentResponse, GoogleGenAI } from '@google/genai';
import {
  ITTSService,
  TTSOptions,
  TTSResult,
  TTSProvider,
  TTSUsage,
  TTSSegment,
} from '../../interfaces.js';
import { logger } from '@/config/logger.js';
import { isTransientError, withRetry } from '@/shared/retry-utils.js';
import { FFMPEG_BINARY } from '@/config/ffmpeg.js';
import { TTSGenerationError, isTTSGenerationError } from '@/services/tts-errors.js';
import { GEMINI_TTS_VOICES, type GeminiTTSVoice } from '@/services/voice-registry.js';
import { stripPauseTags } from '@/shared/tts-text.js';
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

interface PcmFormat {
  sampleRate: number;
  channels: number;
}

interface GeminiAudioResponse {
  audioBuffer: Buffer;
  mimeType: string | undefined;
  /** Set when several WAV parts were merged into headerless s16le PCM. */
  pcmFormat?: PcmFormat;
  usage: TTSUsage | undefined;
  metadata: Record<string, unknown>;
}

const BCP47_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})+$/;

/**
 * Return the locale only when it looks like a BCP-47 tag (e.g. 'pt-PT'), else undefined.
 */
function normalizeLanguageCode(languageCode: string | undefined): string | undefined {
  const trimmed = languageCode?.trim();
  return trimmed && BCP47_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * Detect WAV payloads by mime type or RIFF magic bytes.
 */
function isWavAudio(buffer: Buffer, mimeType: string | undefined): boolean {
  if (mimeType && /audio\/(x-)?wav|audio\/wave/i.test(mimeType)) return true;
  return buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'RIFF';
}

const DEFAULT_PCM_FORMAT: PcmFormat = { sampleRate: 24000, channels: 1 };
const FFMPEG_CONVERSION_TIMEOUT_MS = 120_000;

/**
 * Parse a WAV file by walking its RIFF chunks (headers are not always 44 bytes; extra
 * chunks such as LIST may precede `data`). Returns the format and the PCM payload.
 */
export function parseWav(buffer: Buffer): {
  format: PcmFormat;
  bitsPerSample: number;
  pcm: Buffer;
} {
  if (
    buffer.length < 12 ||
    buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buffer.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    throw new Error('Not a RIFF/WAVE buffer');
  }

  let format: PcmFormat | undefined;
  let bitsPerSample = 16;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString('ascii');
    const size = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (id === 'fmt ' && bodyStart + 16 <= buffer.length) {
      format = {
        channels: buffer.readUInt16LE(bodyStart + 2),
        sampleRate: buffer.readUInt32LE(bodyStart + 4),
      };
      bitsPerSample = buffer.readUInt16LE(bodyStart + 14);
    } else if (id === 'data') {
      // Streamed WAVs may declare a bogus size; clamp to what is actually present
      const end = Math.min(bodyStart + size, buffer.length);
      if (!format) {
        throw new Error('WAV data chunk found before fmt chunk');
      }
      return { format, bitsPerSample, pcm: buffer.subarray(bodyStart, end) };
    }
    // Chunks are word-aligned
    offset = bodyStart + size + (size % 2);
  }
  throw new Error('WAV buffer has no data chunk');
}

/**
 * Merge several WAV buffers into one headerless s16le PCM payload, using the first
 * part's sample rate and channel count.
 */
export function mergeWavParts(buffers: Buffer[]): { pcm: Buffer; format: PcmFormat } {
  const parsed = buffers.map((buffer) => parseWav(buffer));
  const first = parsed[0];
  if (!first) {
    throw new Error('No WAV parts to merge');
  }
  for (const part of parsed) {
    if (part.bitsPerSample !== 16) {
      throw new Error(`Unsupported WAV bit depth: ${part.bitsPerSample}`);
    }
    if (
      part.format.sampleRate !== first.format.sampleRate ||
      part.format.channels !== first.format.channels
    ) {
      logger.warn('Gemini TTS WAV parts differ in format; using the first part format', {
        first: first.format,
        other: part.format,
      });
    }
  }
  return { pcm: Buffer.concat(parsed.map((part) => part.pcm)), format: first.format };
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

  const audioParts = candidates
    .map((candidate) =>
      (candidate.content?.parts ?? []).flatMap((part) => {
        const data = part.inlineData?.data;
        const mimeType = part.inlineData?.mimeType;
        if (!data || (mimeType && !mimeType.startsWith('audio/'))) {
          return [];
        }
        return [{ buffer: Buffer.from(data, 'base64'), mimeType }];
      }),
    )
    .find((parts) => parts.length > 0);

  if (!audioParts) {
    throw new TTSGenerationError('Gemini TTS returned no audio data', {
      code: 'GEMINI_TTS_EMPTY_AUDIO',
      statusCode: 502,
      retryable: true,
      details: metadata,
    });
  }

  const usageMetadata = response.usageMetadata;
  const audioTokens = usageMetadata?.candidatesTokensDetails?.find(
    (detail) => detail.modality === 'AUDIO',
  )?.tokenCount;
  const usage: TTSUsage | undefined = usageMetadata
    ? {
        inputTokens: usageMetadata.promptTokenCount ?? 0,
        outputTokens: audioTokens ?? usageMetadata.candidatesTokenCount ?? 0,
      }
    : undefined;

  // Each WAV part carries its own RIFF header, so parts cannot be byte-concatenated.
  if (audioParts.length > 1 && audioParts.every((p) => isWavAudio(p.buffer, p.mimeType))) {
    try {
      const merged = mergeWavParts(audioParts.map((part) => part.buffer));
      return {
        audioBuffer: merged.pcm,
        mimeType: `audio/L16;codec=pcm;rate=${merged.format.sampleRate}`,
        pcmFormat: merged.format,
        usage,
        metadata,
      };
    } catch (error) {
      throw new TTSGenerationError('Gemini TTS returned unreadable WAV audio parts', {
        code: 'GEMINI_TTS_INVALID_WAV',
        statusCode: 502,
        retryable: true,
        details: metadata,
        cause: error,
      });
    }
  }

  return {
    audioBuffer: Buffer.concat(audioParts.map((part) => part.buffer)),
    mimeType: audioParts[0]?.mimeType,
    usage,
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

/** Curated voices live in the voice registry; re-exported for provider consumers. */
export { GEMINI_TTS_VOICES };
export type { GeminiTTSVoice };

/**
 * The only supported Google Gemini TTS model.
 */
export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts';

export const GEMINI_TTS_MODELS = [DEFAULT_GEMINI_TTS_MODEL] as const;

export type GeminiTTSModel = (typeof GEMINI_TTS_MODELS)[number];

export function isSupportedGeminiTTSModel(model: string): model is GeminiTTSModel {
  return (GEMINI_TTS_MODELS as readonly string[]).includes(model);
}

/**
 * Build the request parts. The transcript is sent verbatim; delivery direction travels
 * as per-part speechMetadata.style, never inside the spoken text. When segments are
 * given, each becomes its own styled part (in order) so the mood can change mid-chunk.
 */
export function buildGeminiSpeechParts(
  text: string,
  style: string | undefined,
  segments: TTSSegment[] | undefined,
): Array<{ text: string; speechMetadata?: { style: string } }> {
  const usable = (segments ?? []).filter((segment) => segment.text.trim() !== '');
  const source = usable.length > 0 ? usable : [{ text, style }];
  return source.map((segment) => {
    const partStyle = segment.style?.trim();
    return partStyle
      ? { text: segment.text, speechMetadata: { style: partStyle } }
      : { text: segment.text };
  });
}

export class GoogleGenAITTSService implements ITTSService {
  private client: GoogleGenAI;
  private model: string;
  private defaultVoice: string;

  constructor(config: GoogleGenAITTSConfig) {
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
    this.model = config.model || DEFAULT_GEMINI_TTS_MODEL;
    if (!isSupportedGeminiTTSModel(this.model)) {
      throw new Error(
        `Unsupported Gemini TTS model "${this.model}". Only ${DEFAULT_GEMINI_TTS_MODEL} is supported.`,
      );
    }
    this.defaultVoice = config.defaultVoice || 'Charon';
    // Note: Gemini TTS doesn't support speed parameter directly
  }

  /**
   * Convert Gemini audio to MP3 using ffmpeg.
   * WAV payloads are parsed by ffmpeg itself because the header length varies; a payload
   * without a RIFF header is treated as raw 24kHz 16-bit mono little-endian PCM.
   */
  private async convertToMp3(
    audioBuffer: Buffer,
    wav: boolean,
    pcmFormat: PcmFormat = DEFAULT_PCM_FORMAT,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;

      const finish = (error?: Error): void => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve(Buffer.concat(chunks));
        }
      };

      const inputStream = new Readable();
      inputStream.push(audioBuffer);
      inputStream.push(null);

      const outputStream = new PassThrough();

      outputStream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      outputStream.on('end', () => {
        finish();
      });

      outputStream.on('error', (err: unknown) => {
        finish(err instanceof Error ? err : new Error(String(err)));
      });

      const command = ffmpeg(inputStream);

      const timer = setTimeout(() => {
        logger.error('FFmpeg conversion timed out', { timeoutMs: FFMPEG_CONVERSION_TIMEOUT_MS });
        finish(
          new TTSGenerationError('FFmpeg MP3 conversion timed out', {
            code: 'FFMPEG_CONVERSION_TIMEOUT',
            statusCode: 504,
            retryable: true,
          }),
        );
        try {
          command.kill('SIGKILL');
        } catch {
          // Process may already be gone
        }
      }, FFMPEG_CONVERSION_TIMEOUT_MS);

      if (wav) {
        command.inputFormat('wav');
      } else {
        command
          .inputFormat('s16le')
          .inputOptions([`-ar ${pcmFormat.sampleRate}`, `-ac ${pcmFormat.channels}`]);
      }

      command
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .format('mp3')
        .on('error', (err: Error) => {
          logger.error('FFmpeg conversion error', {
            error: err.message,
          });
          finish(err);
        })
        .pipe(outputStream, { end: true });
    });
  }

  /**
   * Synthesize speech from text using Google Gemini TTS
   */
  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    const voice = options?.voice || this.defaultVoice;
    const apiModel = options?.model || this.model;

    if (!isSupportedGeminiTTSModel(apiModel)) {
      throw new TTSGenerationError(
        `Unsupported Gemini TTS model "${apiModel}". Only ${DEFAULT_GEMINI_TTS_MODEL} is supported.`,
        {
          code: 'GEMINI_TTS_UNSUPPORTED_MODEL',
          // Configuration error: non-retryable, like BACKGROUND_MUSIC_UNAVAILABLE
          statusCode: 424,
          retryable: false,
        },
      );
    }

    const style = options?.style?.trim() || undefined;
    const language = options?.language;
    const languageCode = normalizeLanguageCode(options?.languageCode ?? language);
    const chapterNumber = options?.chapterNumber;

    try {
      logger.info('Generating TTS with Google Gemini', {
        model: apiModel,
        voice,
        textLength: text.length,
        hasStyle: !!style,
        segmentCount: options?.segments?.length ?? 0,
        languageCode,
        language,
      });

      // Pause tags are never used: the model can read them aloud. Strip any stray one from
      // the text and from every segment before it reaches the request.
      const cleanText = stripPauseTags(text);
      const cleanSegments = options?.segments?.map((segment) => ({
        ...segment,
        text: stripPauseTags(segment.text),
      }));
      const strippedPauseTags =
        cleanText !== text ||
        (cleanSegments?.some(
          (segment, index) => segment.text !== options?.segments?.[index]?.text,
        ) ??
          false);
      if (strippedPauseTags) {
        logger.debug('Stripped stray pause tags from the Gemini TTS transcript', {
          model: apiModel,
          chapterNumber,
        });
      }

      const contents = [
        {
          role: 'user',
          parts: buildGeminiSpeechParts(cleanText, style, cleanSegments),
        },
      ];

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
            contents,
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                ...(languageCode ? { languageCode } : {}),
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: voice,
                  },
                },
              },
            },
          });

          // Validate within the retry boundary. Gemini TTS can occasionally
          // return text or an empty candidate instead of audio.
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

      const wav = isWavAudio(synthesis.audioBuffer, synthesis.mimeType);

      logger.debug('Gemini TTS synthesis successful, converting audio to MP3', {
        model: apiModel,
        voice,
        audioBufferSize: synthesis.audioBuffer.length,
        mimeType: synthesis.mimeType,
        wav,
        pcmFormat: synthesis.pcmFormat,
        response: synthesis.metadata,
      });

      const mp3Buffer = synthesis.pcmFormat
        ? await this.convertToMp3(synthesis.audioBuffer, wav, synthesis.pcmFormat)
        : await this.convertToMp3(synthesis.audioBuffer, wav);

      logger.debug('Audio to MP3 conversion complete', {
        sourceSize: synthesis.audioBuffer.length,
        mp3Size: mp3Buffer.length,
      });

      return {
        buffer: mp3Buffer,
        format: 'mp3',
        sampleRate: 24000, // Gemini TTS outputs at 24kHz
        voice,
        model: apiModel,
        provider: 'google-genai',
        ...(synthesis.usage ? { usage: synthesis.usage } : {}),
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
   * Get the maximum text length supported by Gemini TTS.
   * gemini-3.8-flash-tts limits: 8,192 input tokens and 16,384 output tokens (about 655 s
   * of audio). 4,500 characters is roughly 310 s of audio (~7,800 audio tokens) per call,
   * well inside both limits; a single ~4,900-character request was validated live and
   * returned a complete transcript in ~47 s. Chapters above this are chunked and
   * concatenated afterward.
   */
  getMaxTextLength(): number {
    return 4500;
  }

  /**
   * Get the provider identifier
   */
  getProvider(): TTSProvider {
    return 'google-genai';
  }
}
