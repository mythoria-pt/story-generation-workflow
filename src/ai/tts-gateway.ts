/**
 * TTS Gateway Factory
 * Creates appropriate TTS service instances based on environment configuration
 */

import { ITTSService, TTSProvider } from './interfaces.js';
import { OpenAITTSService } from './providers/openai/tts.js';
import { GoogleGenAITTSService } from './providers/google-genai/tts.js';
import { logger } from '@/config/logger.js';

export interface TTSGatewayConfig {
  provider: TTSProvider;
  model?: string | undefined;
  defaultVoice?: string | undefined;
  defaultSpeed?: number | undefined;
  credentials: {
    openaiApiKey?: string;
    googleGenAIApiKey?: string;
  };
}

export class TTSGateway {
  private ttsService: ITTSService;
  private config: TTSGatewayConfig;

  constructor(config: TTSGatewayConfig) {
    this.config = config;
    this.ttsService = this.createTTSService();

    logger.info('TTS Gateway initialized', {
      provider: config.provider,
      model: config.model,
      defaultVoice: config.defaultVoice,
    });
  }

  private createTTSService(): ITTSService {
    switch (this.config.provider) {
      case 'openai':
        if (!this.config.credentials.openaiApiKey) {
          throw new Error('OpenAI API Key is required for OpenAI TTS service');
        }
        return new OpenAITTSService({
          apiKey: this.config.credentials.openaiApiKey,
          model: this.config.model,
          defaultVoice: this.config.defaultVoice,
          defaultSpeed: this.config.defaultSpeed,
        });

      case 'google-genai':
        if (!this.config.credentials.googleGenAIApiKey) {
          throw new Error('Google GenAI API Key is required for Gemini TTS service');
        }
        return new GoogleGenAITTSService({
          apiKey: this.config.credentials.googleGenAIApiKey,
          model: this.config.model,
          defaultVoice: this.config.defaultVoice,
          defaultSpeed: this.config.defaultSpeed,
        });

      default:
        throw new Error(`Unsupported TTS provider: ${this.config.provider}`);
    }
  }

  /**
   * Get the TTS service instance
   */
  public getTTSService(): ITTSService {
    return this.ttsService;
  }

  /**
   * Get the configured provider
   */
  public getProvider(): TTSProvider {
    return this.config.provider;
  }

  /**
   * Create TTS Gateway from environment variables
   */
  public static fromEnvironment(): TTSGateway {
    const provider = (process.env.TTS_PROVIDER || 'openai') as TTSProvider;
    const model = process.env.TTS_MODEL;
    const defaultVoice = process.env.TTS_VOICE;
    const defaultSpeed = process.env.TTS_SPEED ? parseFloat(process.env.TTS_SPEED) : undefined;

    const config: TTSGatewayConfig = {
      provider,
      model,
      defaultVoice,
      defaultSpeed,
      credentials: {
        ...(process.env.OPENAI_API_KEY && {
          openaiApiKey: process.env.OPENAI_API_KEY,
        }),
        ...(process.env.GOOGLE_GENAI_API_KEY && {
          googleGenAIApiKey: process.env.GOOGLE_GENAI_API_KEY,
        }),
      },
    };

    return new TTSGateway(config);
  }
}

// Singleton instance for convenience
let ttsGatewayInstance: TTSGateway | null = null;

/**
 * Get or create the TTS Gateway singleton
 */
export function getTTSGateway(): TTSGateway {
  if (!ttsGatewayInstance) {
    ttsGatewayInstance = TTSGateway.fromEnvironment();
  }
  return ttsGatewayInstance;
}

/**
 * Reset the TTS Gateway singleton (useful for testing)
 */
export function resetTTSGateway(): void {
  ttsGatewayInstance = null;
}
