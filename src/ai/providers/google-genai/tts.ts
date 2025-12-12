/**
 * Google Gemini TTS (Text-to-Speech) Provider
 * Implements ITTSService for Google's Gemini TTS API (gemini-2.5-pro-preview-tts)
 *
 * Note: Gemini TTS outputs raw PCM audio at 24kHz, 16-bit, mono.
 * This provider converts PCM to MP3 using fluent-ffmpeg.
 */

import { GoogleGenAI } from '@google/genai';
import { ITTSService, TTSOptions, TTSResult, TTSProvider } from '../../interfaces.js';
import { logger } from '@/config/logger.js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { Readable, PassThrough } from 'stream';

// Set ffmpeg path from installer
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

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
    this.model = config.model || 'gemini-2.5-pro-preview-tts';
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

      outputStream.on('error', (err) => {
        reject(err);
      });

      // Convert PCM to MP3
      // Gemini TTS outputs: 24kHz, 16-bit, mono, little-endian PCM
      ffmpeg(inputStream)
        .inputFormat('s16le') // signed 16-bit little-endian
        .inputOptions(['-ar 24000', '-ac 1']) // 24kHz, mono
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .format('mp3')
        .on('error', (err) => {
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
    const systemPrompt = options?.systemPrompt;
    // Note: Gemini TTS doesn't support speed parameter directly,
    // but we can include speed instructions in the prompt

    try {
      logger.info('Generating TTS with Google Gemini', {
        model,
        voice,
        textLength: text.length,
        hasSystemPrompt: !!systemPrompt,
      });

      // Build the content for the request
      // Note: Gemini TTS does NOT support multi-turn chat, so we combine
      // system prompt and text into a single message
      let contentText: string;
      if (systemPrompt) {
        // Combine system instructions with the text to read in a single turn
        contentText = `${systemPrompt}\n\nRead the following text:\n\n${text}`;
      } else {
        contentText = text;
      }

      // Gemini TTS uses the generate_content API with audio response modality
      const response = await this.client.models.generateContent({
        model,
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

      // Extract audio data from response
      const candidate = response.candidates?.[0];
      if (!candidate?.content?.parts?.[0]) {
        throw new Error('No audio data in Gemini TTS response');
      }

      const audioPart = candidate.content.parts[0];
      if (!audioPart.inlineData?.data) {
        throw new Error('No inline audio data in Gemini TTS response');
      }

      // Gemini returns base64-encoded PCM audio
      const pcmBuffer = Buffer.from(audioPart.inlineData.data, 'base64');

      logger.debug('Gemini TTS synthesis successful, converting PCM to MP3', {
        model,
        voice,
        pcmBufferSize: pcmBuffer.length,
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
        model,
        provider: 'google-genai',
      };
    } catch (error) {
      logger.error('Google Gemini TTS synthesis failed', {
        error: error instanceof Error ? error.message : String(error),
        model,
        voice,
      });
      throw error;
    }
  }

  /**
   * Get the maximum text length supported by Gemini TTS
   * Gemini TTS has a context window of ~32k tokens for TTS
   * Being conservative with character limit
   */
  getMaxTextLength(): number {
    return 8000; // Conservative limit, actual is much higher
  }

  /**
   * Get the provider identifier
   */
  getProvider(): TTSProvider {
    return 'google-genai';
  }
}
