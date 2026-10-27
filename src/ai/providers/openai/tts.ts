/**
 * OpenAI TTS (Text-to-Speech) Provider
 * Implements ITTSService for OpenAI's audio.speech API
 */

import OpenAI from 'openai';
import { ITTSService, TTSOptions, TTSResult, TTSProvider } from '../../interfaces.js';
import { logger } from '@/config/logger.js';
import { stripPauseTags } from '@/shared/tts-text.js';

export interface OpenAITTSConfig {
  apiKey: string;
  model?: string | undefined;
  defaultVoice?: string | undefined;
  defaultSpeed?: number | undefined;
}

/** OpenAI TTS voices live in the voice registry; re-exported for provider consumers. */
import type { OpenAITTSVoice } from '@/services/voice-registry.js';
export { OPENAI_TTS_VOICES } from '@/services/voice-registry.js';
export type { OpenAITTSVoice };

/**
 * OpenAI TTS models
 */
export const OPENAI_TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] as const;

export type OpenAITTSModel = (typeof OPENAI_TTS_MODELS)[number];

export class OpenAITTSService implements ITTSService {
  private client: OpenAI;
  private model: string;
  private defaultVoice: string;
  private defaultSpeed: number;

  constructor(config: OpenAITTSConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
    });
    this.model = config.model || 'gpt-4o-mini-tts';
    this.defaultVoice = config.defaultVoice || 'coral';
    this.defaultSpeed = config.defaultSpeed || 1.0;
  }

  /**
   * Synthesize speech from text using OpenAI TTS
   */
  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    const voice = options?.voice || this.defaultVoice;
    const speed = options?.speed || this.defaultSpeed;
    const model = options?.model || this.model;
    const systemPrompt = options?.systemPrompt;

    try {
      logger.info('Generating TTS with OpenAI', {
        model,
        voice,
        speed,
        textLength: text.length,
        hasSystemPrompt: !!systemPrompt,
      });

      // Pause tags are never used (they can be read aloud); strip any stray one defensively.
      const inputText = stripPauseTags(text).trim();
      if (inputText !== text.trim()) {
        logger.debug('Stripped stray pause tags from the OpenAI TTS input', { model });
      }

      // gpt-4o-mini-tts supports a dedicated `instructions` parameter; tts-1 / tts-1-hd do not.
      const supportsInstructions = model.startsWith('gpt-4o');

      const response = await this.client.audio.speech.create({
        model: model as OpenAITTSModel,
        voice: voice as OpenAITTSVoice,
        input: inputText,
        ...(systemPrompt && supportsInstructions ? { instructions: systemPrompt } : {}),
        speed,
        response_format: 'mp3',
      });

      const buffer = Buffer.from(await response.arrayBuffer());

      logger.debug('OpenAI TTS synthesis successful', {
        model,
        voice,
        bufferSize: buffer.length,
      });

      return {
        buffer,
        format: 'mp3',
        sampleRate: 24000, // OpenAI TTS outputs at 24kHz
        voice,
        model,
        provider: 'openai',
      };
    } catch (error) {
      logger.error('OpenAI TTS synthesis failed', {
        error: error instanceof Error ? error.message : String(error),
        model,
        voice,
      });
      throw error;
    }
  }

  /**
   * Get the maximum text length supported by OpenAI TTS
   * OpenAI TTS has a limit of 4096 characters per request
   */
  getMaxTextLength(): number {
    return 4096;
  }

  /**
   * Get the provider identifier
   */
  getProvider(): TTSProvider {
    return 'openai';
  }
}
