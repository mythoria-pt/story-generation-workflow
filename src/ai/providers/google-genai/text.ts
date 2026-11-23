import {
  GoogleGenAI,
  MediaResolution,
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
  type ThinkingLevel,
} from '@google/genai';
import type {
  ITextGenerationService,
  TextGenerationOptions,
  TextGenerationUsage,
} from '../../interfaces.js';
import { contextManager } from '../../context-manager.js';
import { logger } from '@/config/logger.js';

export const HYDROGEN_MODEL = 'gemini-4-hydrogen';
export const HYDROGEN_CONTEXT_TOKENS = 1_048_576;
export const HYDROGEN_HEADROOM_TOKENS = 8192;
export interface GoogleGenAITextConfig {
  apiKey: string;
  model?: string;
}
export interface HydrogenRequest {
  model: string;
  contents: Content[];
  config: GenerateContentConfig;
}
export interface HydrogenSegment {
  parts: Part[];
  finishReason: string;
  continuationToken?: string;
  usage: TextGenerationUsage;
}

export function hydrogenUsage(response: GenerateContentResponse): TextGenerationUsage {
  const raw = response as GenerateContentResponse & { response?: GenerateContentResponse };
  const usage = raw.usageMetadata ?? raw.response?.usageMetadata;
  const output = usage?.candidatesTokenCount;
  const thinking = usage?.thoughtsTokenCount ?? 0;
  return {
    provider: 'google-genai',
    model: HYDROGEN_MODEL,
    ...(usage && {
      inputTokens: usage.promptTokenCount,
      outputTokens:
        output == null
          ? usage.totalTokenCount == null
            ? undefined
            : Math.max(0, usage.totalTokenCount - (usage.promptTokenCount ?? 0))
          : output + thinking,
      thinkingTokens: thinking,
      cachedInputTokens: usage.cachedContentTokenCount ?? 0,
      totalTokens: usage.totalTokenCount,
    }),
  };
}

export class GoogleGenAITextService implements ITextGenerationService {
  private genAI: GoogleGenAI;
  constructor(config: GoogleGenAITextConfig) {
    this.assertModel(config.model);
    this.genAI = new GoogleGenAI({ apiKey: config.apiKey, apiVersion: 'v1beta' });
    logger.info('Google GenAI text service initialized', {
      provider: 'google-genai',
      model: HYDROGEN_MODEL,
      apiVersion: 'v1beta',
    });
  }
  private assertModel(model?: string) {
    if (model && model !== HYDROGEN_MODEL)
      throw new Error('Only gemini-4-hydrogen is supported for Gemini text generation');
  }
  async prepareRequest(
    prompt: string,
    options: TextGenerationOptions = {},
    history: Content[] = [],
  ): Promise<HydrogenRequest> {
    this.assertModel(options.model);
    if (
      options.thinkingLevel &&
      !['low', 'medium', 'high', 'xhigh'].includes(options.thinkingLevel)
    )
      throw new Error('Unsupported Hydrogen thinking level');
    const parts: Part[] = [{ text: prompt }];
    for (const media of options.mediaParts ?? [])
      parts.push({
        inlineData: { mimeType: media.mimeType, data: Buffer.from(media.data).toString('base64') },
      });
    const config: GenerateContentConfig = {
      maxOutputTokens: options.maxTokens ?? 65536,
      thinkingConfig: {
        thinkingLevel: (options.thinkingLevel ?? 'high').toUpperCase() as ThinkingLevel,
      },
      ...(options.systemInstruction && { systemInstruction: options.systemInstruction }),
      ...(options.jsonSchema && {
        responseMimeType: 'application/json',
        responseJsonSchema: options.jsonSchema,
      }),
      ...(options.googleSearchGrounding && { tools: [{ googleSearch: {} }] }),
      ...(options.stopSequences && { stopSequences: options.stopSequences }),
      ...(options.mediaResolution && {
        mediaResolution: {
          low: MediaResolution.MEDIA_RESOLUTION_LOW,
          medium: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
          high: MediaResolution.MEDIA_RESOLUTION_HIGH,
        }[options.mediaResolution],
      }),
    };
    const requestedOutput = config.maxOutputTokens ?? 65536;
    if (
      !Number.isInteger(requestedOutput) ||
      requestedOutput < 1 ||
      requestedOutput > HYDROGEN_CONTEXT_TOKENS
    )
      throw new Error('Invalid Hydrogen output budget');
    const contents = [...history, { role: 'user', parts }];
    // Developer API countTokens rejects systemInstruction/tools config fields. Count their
    // serialized text alongside contents and retain headroom for wire-format overhead.
    const prefix = [config.systemInstruction, config.tools, config.responseJsonSchema]
      .filter(Boolean)
      .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
      .join('\n');
    const count = await this.genAI.models.countTokens({
      model: HYDROGEN_MODEL,
      contents: [...(prefix ? [{ role: 'user', parts: [{ text: prefix }] }] : []), ...contents],
      config: {
        ...(options.signal && { abortSignal: options.signal }),
        httpOptions: { timeout: 50000, retryOptions: { attempts: 1 } },
      },
    });
    if (count.totalTokens == null) throw new Error('Hydrogen input token count unavailable');
    const available = HYDROGEN_CONTEXT_TOKENS - count.totalTokens - HYDROGEN_HEADROOM_TOKENS;
    if (available < 1) throw new Error('Story context exceeds Hydrogen capacity');
    config.maxOutputTokens = Math.min(requestedOutput, available);
    return { model: HYDROGEN_MODEL, contents, config };
  }
  async generateSegment(
    request: HydrogenRequest,
    continuationToken?: string,
    signal?: AbortSignal,
  ): Promise<HydrogenSegment> {
    this.assertModel(request.model);
    const response = await this.genAI.models.generateContent({
      ...request,
      config: {
        ...request.config,
        automaticContinuation: false,
        ...(continuationToken && { continuationToken }),
        ...(signal && { abortSignal: signal }),
        httpOptions: { timeout: 1_200_000, retryOptions: { attempts: 1 } },
      },
    });
    const raw =
      (response as GenerateContentResponse & { response?: GenerateContentResponse }).response ??
      response;
    const candidate = raw.candidates?.[0];
    const reason = raw.promptFeedback?.blockReason ?? candidate?.finishReason;
    const segment: HydrogenSegment = {
      parts: candidate?.content?.parts ?? [],
      finishReason: candidate?.finishReason ?? (raw.text ? 'STOP' : 'UNKNOWN'),
      usage: hydrogenUsage(response),
      ...(candidate?.continuationToken && { continuationToken: candidate.continuationToken }),
    };
    if (!candidate && raw.text) segment.parts = [{ text: raw.text }];
    if (
      reason &&
      ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'OTHER'].includes(reason)
    )
      throw Object.assign(new Error('Google GenAI content blocked'), {
        status: 422,
        code: reason,
        provider: 'google-genai',
        usage: segment.usage,
      });
    return segment;
  }
  async initializeContext(contextId: string, _systemPrompt: string, previousContent?: string[]) {
    await contextManager.updateProviderData(contextId, {
      googleGenAI: {
        history: previousContent?.length
          ? [{ role: 'user', parts: [{ text: previousContent.join('\n\n') }] }]
          : [],
      },
    });
  }
  async clearContext(contextId: string) {
    await contextManager.updateProviderData(contextId, { googleGenAI: {} });
  }
  async complete(prompt: string, options: TextGenerationOptions = {}): Promise<string> {
    try {
      const context = options.contextId ? await contextManager.getContext(options.contextId) : null;
      // Explicit instructions describe a self-contained request; do not duplicate its history.
      const history = options.systemInstruction
        ? []
        : (context?.providerSpecificData.googleGenAI?.history ?? []);
      const request = await this.prepareRequest(
        prompt,
        { ...options, systemInstruction: options.systemInstruction ?? context?.systemPrompt },
        history,
      );
      const parts: Part[] = [];
      let token: string | undefined;
      for (let index = 0; index < 32; index++) {
        const segment = await this.generateSegment(request, token, options.signal);
        options.usageObserver?.(segment.usage);
        parts.push(...segment.parts);
        if (segment.finishReason === 'CONTINUATION' && segment.continuationToken) {
          token = segment.continuationToken;
          continue;
        }
        if (segment.finishReason !== 'STOP')
          throw Object.assign(
            new Error(`Hydrogen generation incomplete: ${segment.finishReason}`),
            { code: 'INCOMPLETE_OUTPUT' },
          );
        const text = parts
          .filter((part) => !part.thought)
          .map((part) => part.text ?? '')
          .join('');
        if (!text.trim()) throw new Error('No text content in Google GenAI response');
        if (options.contextId && context && !options.systemInstruction)
          await contextManager.updateProviderData(options.contextId, {
            googleGenAI: { history: [...request.contents, { role: 'model', parts }] },
          });
        return text;
      }
      throw new Error('Hydrogen continuation segment limit exceeded');
    } catch (error) {
      const failure = error as { code?: string; status?: number; usage?: TextGenerationUsage };
      if (failure.usage) options.usageObserver?.(failure.usage);
      logger.error('Google text generation failed', {
        provider: 'google-genai',
        model: HYDROGEN_MODEL,
        contextId: options.contextId,
        code: failure.code,
        status: failure.status,
      });
      if (options.privateContent)
        throw Object.assign(new Error('Private text generation failed'), {
          code: failure.code,
          status: failure.status,
        });
      throw error;
    }
  }
}
