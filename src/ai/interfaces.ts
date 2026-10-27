/**
 * AI Gateway Interfaces
 * Provider-agnostic interfaces for text and image generation services
 */

export interface TextGenerationUsage {
  provider?: 'google-genai' | 'openai' | 'unknown';
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  billedUnits?: number;
}

export interface ITextGenerationService {
  /**
   * Complete a text generation request
   * @param prompt The input prompt
   * @param options Additional generation options
   */
  complete(prompt: string, options?: TextGenerationOptions): Promise<string>;

  /**
   * Initialize or update context for a story generation session
   * @param contextId Unique identifier for the context session
   * @param systemPrompt The system prompt that defines the story context
   * @param previousContent Previous conversation content to maintain context
   */
  initializeContext?(
    contextId: string,
    systemPrompt: string,
    previousContent?: string[],
  ): Promise<void>;

  /**
   * Clear context for a specific session
   * @param contextId Unique identifier for the context session
   */
  clearContext?(contextId: string): Promise<void>;
}

export interface IImageGenerationService {
  /**
   * Generate an image from a text prompt
   * @param prompt The image description prompt
   * @param options Additional generation options
   */
  generate(prompt: string, options?: ImageGenerationOptions): Promise<Buffer>;

  /**
   * Edit an existing image based on a text prompt
   * @param prompt The image editing prompt
   * @param originalImage The original image as Buffer
   * @param options Additional generation options
   */
  edit?(prompt: string, originalImage: Buffer, options?: ImageGenerationOptions): Promise<Buffer>;
}

export interface TextGenerationOptions {
  signal?: AbortSignal;
  /** Omit input/output content from provider logs and persisted token telemetry. */
  privateContent?: boolean;
  maxTokens?: number;
  /** Provider-specific sampling control. Used by OpenAI; never sent to Gemini 3.6+. */
  temperature?: number;
  stopSequences?: string[];
  model?: string;
  contextId?: string; // For context preservation across requests
  jsonSchema?: object; // JSON schema for structured output
  mediaParts?: Array<{ mimeType: string; data: Buffer | string }>; // Optional media attachments for multimodal
  usageObserver?: (usage: TextGenerationUsage) => void; // Optional callback for provider usage metadata
  // Gemini 3 specific options
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'; // Controls Gemini 3's reasoning depth (default: medium for Flash)
  mediaResolution?: 'low' | 'medium' | 'high'; // Controls multimodal token allocation (Gemini 3)
  systemInstruction?: string | undefined; // Optional system instruction for the request (when not using stateful context)
  googleSearchGrounding?: boolean; // Enable Google Search grounding for real-time information
}

export interface ImageGenerationOptions {
  width?: number;
  height?: number;
  aspectRatio?: string;
  model?: string;
  quality?: 'standard' | 'hd';
  style?: 'vivid' | 'natural';
  steps?: number;
  customInstructions?: string;
  bookTitle?: string;
  graphicalStyle?: string;
  imageType?: 'front_cover' | 'back_cover' | 'chapter';
  systemPrompt?: string;
  /**
   * Reference images (JPEG) to guide style/character consistency.
   * Ordered oldest -> newest for narrative continuity.
   * `label` is an optional short caption (e.g. "Character reference: Maya") that Gemini
   * providers interleave as a text part before the image.
   */
  referenceImages?: Array<{ buffer: Buffer; mimeType: string; source: string; label?: string }>;
}

export interface AIProviderConfig {
  textProvider: string;
  imageProvider: string;
  credentials: {
    openaiApiKey?: string;
    openaiUseResponsesAPI?: boolean;
    openaiBaseModel?: string;
    openaiImageToolModel?: string;
    googleGenAIApiKey?: string;
    googleGenAIModel?: string;
    googleGenAIImageModel?: string;
  };
}

export type TextProvider = 'openai' | 'google-genai';
export type ImageProvider = 'openai' | 'google-genai';
export type TTSProvider = 'openai' | 'google-genai';

// ─────────────────────────────────────────────────────────────────────────────
// TTS (Text-to-Speech) Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One ordered slice of a transcript with its own delivery style.
 */
export interface TTSSegment {
  /** Verbatim transcript slice (may contain whitelisted inline audio tags) */
  text: string;
  /** Short delivery-style direction for this slice */
  style?: string;
}

/**
 * Configuration options for TTS synthesis
 */
export interface TTSOptions {
  /** Voice identifier (provider-specific) */
  voice?: string;
  /** Speech speed multiplier (0.25 to 4.0) */
  speed?: number;
  /** Target language code (e.g., 'en-US', 'pt-PT') */
  language?: string;
  /** Model to use for synthesis */
  model?: string;
  /**
   * Accent/style instruction string for OpenAI only (sent via the `instructions`
   * parameter). Gemini uses `style` + `languageCode` instead and is never given this.
   */
  systemPrompt?: string;
  /** Short delivery-style direction (Gemini: sent as per-part speechMetadata.style) */
  style?: string;
  /** BCP-47 locale for synthesis (Gemini: speechConfig.languageCode), e.g. 'pt-PT' */
  languageCode?: string;
  /**
   * Optional ordered partition of the transcript (Gemini only). When present, each segment
   * is sent as its own part with its own speechMetadata.style, and `text`/`style` are
   * ignored by the Gemini provider. Other providers ignore segments.
   */
  segments?: TTSSegment[];
  /** Chapter number for contextual logging */
  chapterNumber?: number;
}

/**
 * Result of a TTS synthesis operation
 */
export interface TTSResult {
  /** Audio data as Buffer */
  buffer: Buffer;
  /** Audio format (mp3, wav, pcm) */
  format: 'mp3' | 'wav' | 'pcm';
  /** Sample rate in Hz */
  sampleRate: number;
  /** Voice used for synthesis */
  voice: string;
  /** Model used for synthesis */
  model: string;
  /** Provider that generated the audio */
  provider: TTSProvider;
  /** Token usage reported by the provider, when available */
  usage?: TTSUsage;
}

/**
 * Token usage reported by a TTS provider
 */
export interface TTSUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Provider-agnostic TTS service interface
 */
export interface ITTSService {
  /**
   * Synthesize speech from text
   * @param text The text to convert to speech
   * @param options TTS configuration options
   */
  synthesize(text: string, options?: TTSOptions): Promise<TTSResult>;

  /**
   * Get the maximum text length supported by this provider
   */
  getMaxTextLength(): number;

  /**
   * Get the provider identifier
   */
  getProvider(): TTSProvider;
}
