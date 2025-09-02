/**
 * AI Gateway API Routes
 * Provider-agnostic endpoints for text and image generation
 */

import { Router } from "express";
import { z } from "zod";
import {
  validateImageRequest,
  generateImageFilename,
  formatImageError,
} from "./ai-image-utils.js";
import { StoryService } from "@/services/story.js";
import { workflowErrorHandler } from "@/shared/workflow-error-handler.js";
import type { StoryContext } from "@/services/story.js";
import { PromptService } from "@/services/prompt.js";
import { SchemaService } from "@/services/schema.js";
import { getImageDimensions } from "@/utils/imageUtils.js";
import { getAIGatewayWithTokenTracking } from "@/ai/gateway-with-tracking-v2.js";
import { getStorageService } from "@/services/storage-singleton.js";
import { logger } from "@/config/logger.js";
import {
  formatTargetAudience,
  getLanguageName,
  parseAIResponse,
} from "@/shared/utils.js";
import { CharacterService } from "@/services/characters.js";
import { eq } from "drizzle-orm";

// Initialize services
const router = Router();
const aiGateway = getAIGatewayWithTokenTracking();
const storyService = new StoryService();
const storageService = getStorageService();
const characterService = new CharacterService();

/**
 * Generate image prompts for a chapter based on its content
 */
async function generateImagePromptsForChapter(
  chapterContent: string,
  storyContext: StoryContext,
  chapterNumber: number,
  chapterTitle: string,
  tokenTrackingContext: {
    authorId: string;
    storyId: string;
    action: "chapter_writing";
  },
): Promise<string[]> {
  try {
    // Create a focused prompt to generate image prompts from the chapter content
    const imagePromptGenerationPrompt = `
You are an expert at creating detailed image prompts for book illustrations. Based on the following chapter content, create 1-3 detailed image prompts that would make compelling illustrations for this chapter.

Chapter Title: "${chapterTitle}"
Chapter Number: ${chapterNumber}
Story Genre: ${storyContext.story.novelStyle || "adventure"}
Target Audience: ${formatTargetAudience(storyContext.story.targetAudience)}

Chapter Content:
${chapterContent}

Instructions:
1. Create 1-3 detailed image prompts that capture the most visual and engaging moments from this chapter
2. Focus on scenes with strong visual elements, character interactions, or dramatic moments
3. Each prompt should be detailed enough for an AI image generator to create a compelling illustration
4. Consider the target audience and genre when describing the visual style
5. Include details about characters, settings, lighting, mood, and composition
6. Each prompt should be 2-3 sentences long

Format your response as a JSON array of strings, like this:
["First detailed image prompt here", "Second detailed image prompt here", "Third detailed image prompt here"]

Return only the JSON array, no other text.
`;

    const imagePromptsResponse = await aiGateway
      .getTextService(tokenTrackingContext)
      .complete(imagePromptGenerationPrompt, {
        maxTokens: 1024,
        temperature: 0.7,
      });

    // Parse the JSON response
    try {
      const imagePrompts = JSON.parse(imagePromptsResponse.trim()) as string[];

      // Validate that we got an array of strings
      if (
        !Array.isArray(imagePrompts) ||
        !imagePrompts.every((prompt) => typeof prompt === "string")
      ) {
        logger.warn(
          "AI returned invalid image prompts format, falling back to default",
          {
            chapterNumber,
            response: imagePromptsResponse,
          },
        );
        return [
          `A scene from chapter ${chapterNumber}: "${chapterTitle}" of this ${storyContext.story.novelStyle || "adventure"} story.`,
        ];
      }

      logger.debug("Generated image prompts for chapter", {
        chapterNumber,
        promptCount: imagePrompts.length,
      });

      return imagePrompts;
    } catch (parseError) {
      logger.warn(
        "Failed to parse AI image prompts response, falling back to default",
        {
          chapterNumber,
          error:
            parseError instanceof Error
              ? parseError.message
              : String(parseError),
          response: imagePromptsResponse,
        },
      );
      return [
        `A scene from chapter ${chapterNumber}: "${chapterTitle}" of this ${storyContext.story.novelStyle || "adventure"} story.`,
      ];
    }
  } catch (error) {
    logger.error("Failed to generate image prompts for chapter", {
      chapterNumber,
      error: error instanceof Error ? error.message : String(error),
    });

    // Return a fallback image prompt
    return [
      `A scene from chapter ${chapterNumber}: "${chapterTitle}" of this ${storyContext.story.novelStyle || "adventure"} story.`,
    ];
  }
}

// Request schemas
const OutlineRequestSchema = z.object({
  storyId: z.string().uuid(),
  runId: z.string().uuid(),
});

const ChapterRequestSchema = z.object({
  storyId: z.string().uuid(),
  runId: z.string().uuid().optional(), // Optional for testing/development
  chapterNumber: z.number().int().positive(),
  chapterTitle: z.string(),
  chapterSynopses: z.string(),
  chapterCount: z.number().int().positive().optional(),
  outline: z
    .object({
      bookTitle: z.string(),
      bookCoverPrompt: z.string(),
      bookBackCoverPrompt: z.string(),
      synopses: z.string(),
      chapters: z.array(
        z.object({
          chapterNumber: z.number().int().positive(),
          chapterTitle: z.string(),
          chapterSynopses: z.string(),
          chapterPhotoPrompt: z.string(),
        }),
      ),
    })
    .optional(),
  previousChapters: z.array(z.string()).optional(),
});

// Type definitions
const OutlineSchema = z.object({
  bookTitle: z.string(),
  bookCoverPrompt: z.string(),
  bookBackCoverPrompt: z.string(),
  synopses: z.string(),
  chapters: z.array(
    z.object({
      chapterNumber: z.number().int().positive(),
      chapterTitle: z.string(),
      chapterSynopses: z.string(),
      chapterPhotoPrompt: z.string(),
    }),
  ),
});

type OutlineData = z.infer<typeof OutlineSchema>;

// Helper function to check if data matches outline structure
function isOutlineData(data: unknown): data is OutlineData {
  try {
    OutlineSchema.parse(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * POST /ai/text/outline
 * Generate story outline using AI text generation with story context from database
 */
router.post("/text/outline", async (req, res) => {
  try {
    const { storyId, runId } = OutlineRequestSchema.parse(req.body);

    // Load story context from database with enhanced error handling
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      // Use the workflow error handler for better diagnostics
      const workflowError = await workflowErrorHandler.handleStoryNotFound(
        storyId,
        runId,
      );
      workflowErrorHandler.logWorkflowError(workflowError);

      const statusCode = workflowError.type === "ORPHANED_RUN" ? 404 : 500;
      res
        .status(statusCode)
        .json(workflowErrorHandler.createErrorResponse(workflowError));
      return;
    } // Load prompt template and prepare variables
    const promptTemplate = await PromptService.loadPrompt(
      "en-US",
      "text-outline",
    ); // Use the chapterCount from the database, fallback to 6 if not available
    const chapterCount = storyContext.story.chapterCount || 6;

    // Prepare template variables
    const templateVars = {
      novelStyle: storyContext.story.novelStyle || "adventure",
      targetAudience: formatTargetAudience(storyContext.story.targetAudience),
      place: storyContext.story.place || "a magical land",
      language: getLanguageName(storyContext.story.storyLanguage),
      chapterCount,
      characters: JSON.stringify(
        storyContext.characters.map((char) => ({
          name: char.name,
          type: char.type || "",
          role: char.role || "",
          age: char.age || "",
          traits: char.traits || [],
          characteristics: char.characteristics || "",
          physicalDescription: char.physicalDescription || "",
        })),
        null,
        2,
      ),
      bookTitle: storyContext.story.title,
      storyDescription:
        storyContext.story.plotDescription ||
        storyContext.story.synopsis ||
        "No description provided",
      description:
        storyContext.story.plotDescription ||
        "No specific plot description provided.",
      graphicalStyle:
        storyContext.story.graphicalStyle ||
        "colorful and vibrant illustration",
      // Placeholder values for template completion
      bookCoverPrompt: "A book cover prompt will be generated",
      bookBackCoverPrompt: "A back cover prompt will be generated",
      synopses: "Story synopsis will be generated",
      chapterNumber: "1",
      chapterPhotoPrompt: "Chapter illustration prompt will be generated",
      chapterTitle: "Chapter title will be generated",
      chapterSynopses: "Chapter synopsis will be generated",
    };

    const finalPrompt = PromptService.buildPrompt(promptTemplate, templateVars);

    // Load JSON schema for structured output
    const storyOutlineSchema = await SchemaService.loadSchema("story-outline"); // Generate outline using AI with specific outline model and JSON schema
    // Use model based on configured text provider
    let outlineModel: string;
    const textProvider = process.env.TEXT_PROVIDER || "google-genai";

    if (textProvider === "openai") {
      outlineModel = process.env.OPENAI_TEXT_MODEL || "gpt-5";
    } else if (textProvider === "google-genai") {
      outlineModel = process.env.GOOGLE_GENAI_MODEL || "gemini-2.5-flash";
    } else {
      outlineModel = "gpt-5";
    }
    const requestOptions = {
      maxTokens: 16384,
      temperature: 1,
      model: outlineModel,
      jsonSchema: storyOutlineSchema,
    }; // Create context for token tracking
    const aiContext = {
      authorId: storyContext.story.authorId,
      storyId: storyId,
      action: "story_outline" as const,
    };

    // Use a deterministic contextId across the workflow (storyId + runId)
    const contextId = `${storyId}:${runId}`;

    const outline = await aiGateway
      .getTextService(aiContext)
      .complete(finalPrompt, {
        ...requestOptions,
        contextId, // ensure the outline response (as first turn) is bound to a context
      });

    // Parse and validate the AI response
    const parsedData = parseAIResponse(outline);

    // Validate that the response matches our expected structure
    if (!isOutlineData(parsedData)) {
      // Type guard failed, so we know parsedData doesn't match OutlineData
      // But we can still safely check basic properties for debugging
      const dataAsRecord =
        parsedData && typeof parsedData === "object"
          ? (parsedData as Record<string, unknown>)
          : {};
      logger.error("Invalid outline structure", {
        hasBookTitle: !!dataAsRecord?.bookTitle,
        hasChapters: !!dataAsRecord?.chapters,
        isChaptersArray: Array.isArray(dataAsRecord?.chapters),
        actualKeys: Object.keys(dataAsRecord),
      });
      throw new Error("Invalid outline structure received");
    }

    const outlineData = parsedData;

    // Initialize chat context after successful outline (system prompt = condensed outline summary)
    try {
      const condensedOutline = `BOOK TITLE: ${outlineData.bookTitle}\nCHAPTERS: ${outlineData.chapters.map(c => `${c.chapterNumber}. ${c.chapterTitle}`).join(" | ")}`.slice(0, 3500);
      // Initialize generic context manager (in-memory) then provider-specific chat
      const { contextManager } = await import("@/ai/context-manager.js");
      const textProvider = process.env.TEXT_PROVIDER || "google-genai";
      await contextManager.initializeContext(contextId, storyId, condensedOutline);
      if (textProvider === "google-genai") {
        // Initialize provider chat instance (will attach to existing context)
        const textService = aiGateway.getTextService(aiContext) as any;
        if (typeof textService.initializeContext === "function") {
          await textService.initializeContext(contextId, condensedOutline);
        }
      }
    } catch (ctxErr) {
      logger.warn("Failed to initialize outline context", {
        error: ctxErr instanceof Error ? ctxErr.message : String(ctxErr),
        storyId,
        runId,
      });
    }

    res.json({
      success: true,
      storyId,
      runId,
      outline: outlineData,
      storyContext: {
        title: storyContext.story.title,
        charactersCount: storyContext.characters.length,
        contextId,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /ai/text/structure
 * Generate structured story + characters from free text (text-only for now)
 */
router.post("/text/structure", async (req, res) => {
  try {
    const RequestSchema = z.object({
      storyId: z.string().uuid(),
      userDescription: z.string().optional(),
      imageData: z.string().nullable().optional(), // legacy base64 (discouraged)
      audioData: z.string().nullable().optional(), // legacy base64 (discouraged)
      imageObjectPath: z.string().optional(), // preferred: object path in bucket
      audioObjectPath: z.string().optional(),
    });

    const {
      storyId,
      userDescription,
      imageObjectPath,
      audioObjectPath,
      imageData,
      audioData,
    } = RequestSchema.parse(req.body);
    logger.info("AI Text Structure: request received", {
      storyId,
      hasText: !!userDescription,
      hasImage: !!req.body?.imageData || !!imageObjectPath,
      hasAudio: !!req.body?.audioData || !!audioObjectPath,
    });

    // Get story and author
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      logger.warn("AI Text Structure: story not found", { storyId });
      res.status(404).json({ success: false, error: "Story not found" });
      return;
    }

    // Load existing author characters
    const existingCharacters = await characterService.getCharactersByAuthor(
      storyContext.story.authorId,
    );

    // Build prompt
    const promptTemplate = await PromptService.loadPrompt(
      "en-US",
      "text-structure",
    );
    const templateVars = {
      authorName: "",
      userDescription: userDescription ?? "",
      existingCharacters: JSON.stringify(
        existingCharacters.map((c) => ({
          characterId: c.characterId,
          name: c.name,
          type: c.type ?? undefined,
          role: undefined,
          characteristics: c.characteristics ?? undefined,
          physicalDescription: c.physicalDescription ?? undefined,
        })),
      ),
    };
    const finalPrompt = PromptService.buildPrompt(promptTemplate, templateVars);
    const structSchema = await SchemaService.loadSchema("story-structure");

    // Model selection
    let model: string;
    const textProvider = process.env.TEXT_PROVIDER || "google-genai";
    if (textProvider === "openai") {
      model = process.env.OPENAI_TEXT_MODEL || "gpt-5";
    } else {
      model = process.env.GOOGLE_GENAI_MODEL || "gemini-2.5-flash";
    }

    // Token tracking context
    const aiContext = {
      authorId: storyContext.story.authorId,
      storyId,
      action: "story_structure" as const,
    };

    // Build media parts if we can use Gemini multimodal
    let aiResponse: string;
    const hasB64Image = typeof imageData === "string" && imageData.length > 0;
    const hasB64Audio = typeof audioData === "string" && audioData.length > 0;
    const canUseGemini =
      textProvider === "google-genai" &&
      (imageObjectPath || audioObjectPath || hasB64Image || hasB64Audio);
    if (canUseGemini) {
      const storage = getStorageService();
      const mediaParts: Array<{ mimeType: string; data: Buffer | string }> = [];
      if (imageObjectPath) {
        const meta = await storage
          .getFileMetadata(imageObjectPath)
          .catch(() => ({ contentType: "image/jpeg" }));
        const buf = await storage.downloadFileAsBuffer(imageObjectPath);
        mediaParts.push({
          mimeType: meta.contentType || "image/jpeg",
          data: buf,
        });
      }
      if (audioObjectPath) {
        const meta = await storage
          .getFileMetadata(audioObjectPath)
          .catch(() => ({ contentType: "audio/wav" }));
        const buf = await storage.downloadFileAsBuffer(audioObjectPath);
        mediaParts.push({
          mimeType: meta.contentType || "audio/wav",
          data: buf,
        });
      }
      // Fallback: attach base64 media directly (dev-friendly, no GCS needed)
      if (hasB64Image) {
        const str = imageData as string;
        let mime = "image/jpeg";
        let b64 = str;
        const match = /^data:([^;]+);base64,(.*)$/.exec(str);
        if (match) {
          mime = (match[1] as string) || mime;
          b64 = (match[2] as string) || b64;
        }
        mediaParts.push({ mimeType: mime, data: Buffer.from(b64, "base64") });
      }
      if (hasB64Audio) {
        const str = audioData as string;
        let mime = "audio/wav";
        let b64 = str;
        const match = /^data:([^;]+);base64,(.*)$/.exec(str);
        if (match) {
          mime = (match[1] as string) || mime;
          b64 = (match[2] as string) || b64;
        }
        mediaParts.push({ mimeType: mime, data: Buffer.from(b64, "base64") });
      }
      aiResponse = await aiGateway
        .getTextService(aiContext)
        .complete(finalPrompt, {
          maxTokens: 16384,
          temperature: 0.8,
          model,
          jsonSchema: structSchema,
          mediaParts,
        } as any);
    } else {
      aiResponse = await aiGateway
        .getTextService(aiContext)
        .complete(finalPrompt, {
          maxTokens: 16384,
          temperature: 0.8,
          model,
          jsonSchema: structSchema,
        });
    }

    const parsed = parseAIResponse(aiResponse) as any;

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.story ||
      !Array.isArray(parsed.characters)
    ) {
      logger.error("Invalid structure response", {
        receivedKeys: parsed ? Object.keys(parsed) : null,
      });
      res
        .status(500)
        .json({ success: false, error: "Invalid structured response from AI" });
      return;
    }

    // Persist story fields (subset already used by app)
    const updates: Record<string, unknown> = {};
    if (parsed.story.title) updates.title = parsed.story.title;
    if (parsed.story.plotDescription)
      updates.plotDescription = parsed.story.plotDescription;
    if (parsed.story.synopsis) updates.synopsis = parsed.story.synopsis;
    if (parsed.story.place) updates.place = parsed.story.place;
    if (parsed.story.additionalRequests)
      updates.additionalRequests = parsed.story.additionalRequests;
    if (parsed.story.targetAudience)
      updates.targetAudience = parsed.story.targetAudience;
    if (parsed.story.novelStyle) updates.novelStyle = parsed.story.novelStyle;
    if (parsed.story.graphicalStyle)
      updates.graphicalStyle = parsed.story.graphicalStyle;
    if (parsed.story.storyLanguage)
      updates.storyLanguage = parsed.story.storyLanguage;

    // Direct DB update via webapp schema synced to SGW
    try {
      const { getDatabase } = await import("@/db/connection.js");
      const { stories } = await import("@/db/schema/index.js");
      await getDatabase()
        .update(stories)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(stories.storyId, storyId));
    } catch (dbErr) {
      logger.error("Failed updating story with structured fields", {
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
      // Continue; characters can still be created/linked
    }

    // Characters create/reuse + link
    const processedCharacters: any[] = [];
    for (const ch of parsed.characters as any[]) {
      let record: any | null = null;
      // Only accept UUIDs; models may emit placeholders like "character_1"
      const isUuid =
        typeof ch.characterId === "string" &&
        /^(?!00000000-0000-0000-0000-000000000000)[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
          ch.characterId,
        );
      if (isUuid) {
        try {
          record = await characterService.getCharacterById(ch.characterId);
        } catch (e) {
          logger.warn(
            "Invalid or not found characterId; creating new character",
            {
              providedId: ch.characterId,
              error: e instanceof Error ? e.message : String(e),
            },
          );
        }
      }
      if (!record) {
        // Keep photoUrl only if it points to our GCS bucket; drop external links (e.g., imgur)
        let safePhotoUrl: string | undefined;
        if (typeof ch.photoUrl === "string") {
          try {
            const u = new URL(ch.photoUrl);
            const isGcs = u.hostname === "storage.googleapis.com";
            const bucket = process.env.STORAGE_BUCKET_NAME;
            if (isGcs && bucket && u.pathname.startsWith(`/${bucket}/`)) {
              safePhotoUrl = ch.photoUrl;
            }
          } catch {
            // ignore invalid URLs
          }
        }
        const createPayload: any = {
          name: ch.name,
          authorId: storyContext.story.authorId,
          type: ch.type,
          role: ch.role,
          age: ch.age,
          traits: Array.isArray(ch.traits) ? ch.traits : undefined,
          characteristics: ch.characteristics,
          physicalDescription: ch.physicalDescription,
        };
        if (safePhotoUrl) createPayload.photoUrl = safePhotoUrl;
        record = await characterService.createCharacter(createPayload);
      }
      if (record) {
        try {
          await characterService.addCharacterToStory(
            storyId,
            record.characterId,
            ch.role,
          );
        } catch (linkErr) {
          logger.warn("Character may already be linked to story", {
            storyId,
            characterId: record.characterId,
            error: linkErr instanceof Error ? linkErr.message : String(linkErr),
          });
        }
        processedCharacters.push({ ...record, role: ch.role ?? undefined });
      }
    }

    res.json({
      success: true,
      storyId,
      story: { ...updates, storyId },
      characters: processedCharacters,
      originalInput: userDescription ?? "",
      hasImageInput: false,
      hasAudioInput: false,
      message: "Story structure generated successfully.",
    });
  } catch (error) {
    res
      .status(500)
      .json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
  }
});

/**
 * POST /ai/media/signed-upload
 * Request a V4 signed URL for direct browser upload to GCS
 * Body: { storyId: uuid, filename?: string, contentType: string, kind: 'image'|'audio' }
 * Stores under mythoria-generated-stories/{storyId}/inputs/<filename>
 */
/**
 * POST /ai/media/upload
 * Server-side upload: accepts base64 data and stores in GCS. No signed URLs.
 * Body: { storyId: uuid, kind: 'image'|'audio', contentType: string, filename?: string, dataUrl: string }
 */
router.post("/media/upload", async (req, res) => {
  try {
    const Schema = z.object({
      storyId: z.string().uuid(),
      kind: z.enum(["image", "audio"]),
      contentType: z.string().min(3),
      filename: z.string().optional(),
      dataUrl: z.string().min(10),
    });
    const { storyId, kind, contentType, filename, dataUrl } = Schema.parse(
      req.body,
    );

    // Ensure story exists
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      res.status(404).json({ success: false, error: "Story not found" });
      return;
    }

    // Decode data URL or raw base64
    let mime = contentType;
    let b64 = dataUrl;
    const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
    if (match) {
      mime = (match[1] as string) || contentType;
      b64 = (match[2] as string) || dataUrl;
    }
    const buffer = Buffer.from(b64, "base64");

    // Build object path and upload
    const folder = `${storyId}/inputs`;
    const defaultExt = kind === "image" ? "jpg" : "wav";
    const safeName =
      filename && filename.trim().length > 0
        ? filename
        : `${kind}-${Date.now()}.${defaultExt}`;
    const objectPath = `${folder}/${safeName}`;

    const publicUrl = await storageService.uploadFile(objectPath, buffer, mime);

    res.json({ success: true, storyId, kind, objectPath, publicUrl });
  } catch (error) {
    res
      .status(400)
      .json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
  }
});

/**
 * POST /ai/text/chapter/:chapterNumber
 * Generate a specific chapter using AI text generation
 */
router.post("/text/chapter/:chapterNumber", async (req, res) => {
  try {
    const chapterNumber = parseInt(req.params.chapterNumber);
    const requestData = { ...req.body, chapterNumber };
    const { storyId, runId, chapterTitle, chapterSynopses, chapterCount } =
      ChapterRequestSchema.parse(requestData);
  const contextId = `${storyId}:${runId}`;

    // Validate chapter number if outline is provided
    if (
      req.body.outline?.chapters &&
      Array.isArray(req.body.outline.chapters)
    ) {
      const maxChapters = req.body.outline.chapters.length;
      if (chapterNumber < 1 || chapterNumber > maxChapters) {
        res.status(400).json({
          success: false,
          error: `Invalid chapter number ${chapterNumber}. Must be between 1 and ${maxChapters}.`,
        });
        return;
      }
    }

    // Get story context from database
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      res.status(404).json({
        success: false,
        error: "Story not found",
      });
      return;
    } // Load chapter prompt template and prepare variables
    const promptTemplate = await PromptService.loadPrompt(
      "en-US",
      "text-chapter",
    );

    // Prepare template variables
    const hookInstruction =
      chapterCount && chapterNumber < chapterCount
        ? "If relevant, you may end with a hook for the next chapter."
        : "";

    const templateVariables = {
      chapterNumber: chapterNumber.toString(),
      chapterTitle: chapterTitle,
      novelStyle: storyContext.story.novelStyle || "adventure",
      averageAge: formatTargetAudience(storyContext.story.targetAudience),
      description:
        storyContext.story.plotDescription || storyContext.story.synopsis || "",
      chapterSynopses: chapterSynopses,
      language: getLanguageName(storyContext.story.storyLanguage),
      chapterCount: chapterCount?.toString() || "10",
      hookInstruction: hookInstruction,
    };

    // Build dynamic memory (previous chapters) heuristic: fetch saved chapters < current
    let memoryPrefix = "";
    try {
      if (chapterNumber > 1) {
        const { ChaptersService } = await import("@/services/chapters.js");
        const chaptersService = new ChaptersService();
        const existing = await chaptersService.getStoryChapters(storyId);
        const prior = existing.filter(c => c.chapterNumber < chapterNumber);
        // Summaries for all but last two, full text for last two
        prior.sort((a,b)=> a.chapterNumber - b.chapterNumber);
        const lastTwo = prior.slice(-2);
        const earlier = prior.slice(0, Math.max(0, prior.length - 2));
        const summarize = (html: string) => {
          const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g,' ').trim();
          // Heuristic summary: first ~450 chars or first 3 sentences
          const sentences = plain.split(/(?<=[.!?])\s+/).slice(0,3).join(' ');
            const snippet = sentences.length > 120 && sentences.length < 500 ? sentences : plain.slice(0,450);
          return snippet;
        };
        const earlierSummaries = earlier.map(c => `Ch${c.chapterNumber} Summary: ${summarize(c.htmlContent)}`);
        const lastTwoFull = lastTwo.map(c => `Ch${c.chapterNumber} Full: ${c.htmlContent.replace(/<[^>]+>/g,' ').trim()}`);
        const outlineChapters = req.body.outline?.chapters ? req.body.outline.chapters.map((c: any)=> `${c.chapterNumber}.${c.chapterTitle}`).join(' | ') : '';
        const parts = [
          outlineChapters && `Outline Chapters: ${outlineChapters}`,
          earlierSummaries.join('\n'),
          lastTwoFull.join('\n'),
          `You are now writing Chapter ${chapterNumber}. Maintain continuity with prior chapters.`
        ].filter(Boolean);
        const rawMemory = parts.join('\n\n');
        // Enforce env-based char cap
        const maxChars = parseInt(process.env.STORY_CONTEXT_MAX_CHARS || '12000',10);
        memoryPrefix = rawMemory.slice(-maxChars); // keep tail (most recent) if overflow
      }
    } catch (memErr) {
      logger.warn('Failed building chapter memory', { storyId, runId, chapterNumber, error: memErr instanceof Error ? memErr.message : String(memErr) });
    }

    // Build the complete prompt with memory prefix
    const basePrompt = PromptService.buildPrompt(
      promptTemplate,
      templateVariables,
    );
    const chapterPrompt = memoryPrefix ? `${memoryPrefix}\n\n${basePrompt}` : basePrompt;

    // Create context for token tracking
    const chapterContext = {
      authorId: storyContext.story.authorId,
      storyId: storyId,
      action: "chapter_writing" as const,
    };

    // Generate chapter content
    const chapterText = await aiGateway
      .getTextService(chapterContext)
      .complete(chapterPrompt, {
        maxTokens: 16384,
        temperature: 1,
        contextId,
      });

    // Generate image prompts based on the chapter content
    const imagePrompts = await generateImagePromptsForChapter(
      chapterText,
      storyContext,
      chapterNumber,
      chapterTitle,
      chapterContext,
    );

    res.json({
      success: true,
      storyId,
      runId: runId || null,
      chapterNumber,
      chapter: chapterText.trim(),
      imagePrompts,
      contextId,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Endpoint to clear context explicitly (used at workflow completion)
router.post('/text/context/clear', async (req, res) => {
  try {
    const Schema = z.object({ storyId: z.string().uuid(), runId: z.string().uuid() });
    const { storyId, runId } = Schema.parse(req.body);
    const contextId = `${storyId}:${runId}`;
    const { contextManager } = await import('@/ai/context-manager.js');
    await contextManager.clearContext(contextId);
    // Provider-specific cleanup (google genai)
    const textProvider = process.env.TEXT_PROVIDER || 'google-genai';
    if (textProvider === 'google-genai') {
      try {
  const service: any = aiGateway.getTextService({ authorId: 'n/a', storyId, action: 'story_outline' });
        if (typeof service.clearContext === 'function') {
          await service.clearContext(contextId);
        }
      } catch (provErr) {
        logger.warn('Provider clearContext failed', { contextId, error: provErr instanceof Error ? provErr.message : String(provErr) });
      }
    }
    res.json({ success: true, contextId });
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'Invalid request' });
  }
});

/**
 * POST /ai/image
 * Generate an image using AI image generation and store it in Google Cloud Storage
 */
router.post("/image", async (req, res) => {
  let currentStep = "parsing_request";
  try {
    const {
      prompt,
      storyId,
      runId,
      chapterNumber,
      imageType,
      width,
      height,
      style,
    } = validateImageRequest(req.body);

    // Get story context to extract authorId for token tracking
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      res.status(404).json({
        success: false,
        error: "Story not found",
      });
      return;
    }

    // Create context for token tracking
    const imageContext = {
      authorId: storyContext.story.authorId,
      storyId: storyId,
      action: "image_generation" as const,
    };

    // Set default dimensions using environment configuration
    let imageWidth = width;
    let imageHeight = height;

    if (!imageWidth && !imageHeight) {
      const dimensions = getImageDimensions(imageType);
      imageWidth = dimensions.width;
      imageHeight = dimensions.height;
    }

    currentStep = "generating_image";
    const imageBuffer = await aiGateway
      .getImageService(imageContext)
      .generate(prompt, {
        ...(imageWidth && { width: imageWidth }),
        ...(imageHeight && { height: imageHeight }),
        ...(style && { style }),
        bookTitle: storyContext.story.title,
        ...(storyContext.story.graphicalStyle && {
          graphicalStyle: storyContext.story.graphicalStyle,
        }),
        ...(imageType && { imageType }),
      });

    currentStep = "preparing_upload";
    const filename = generateImageFilename({
      storyId,
      ...(imageType ? { imageType } : {}),
      ...(chapterNumber !== undefined ? { chapterNumber } : {}),
    });
    currentStep = "uploading_to_storage";
    const imageUrl = await storageService.uploadFile(
      filename,
      imageBuffer,
      "image/jpeg",
    );

    res.json({
      success: true,
      storyId,
      runId,
      chapterNumber,
      image: {
        url: imageUrl,
        filename,
        format: "jpeg",
        size: imageBuffer.length,
      },
    });
  } catch (error) {
    const errorDetails = formatImageError(error, req.body, currentStep);

    res.status(500).json({
      success: false,
      error: errorDetails.message,
      failedAt: currentStep,
      timestamp: errorDetails.timestamp,
      requestId: req.body.runId || "unknown",
    });
  }
});

/**
 * GET /ai/test-text
 * Test the configured text AI provider with environment variables and basic prompt
 */
router.get("/test-text", async (_req, res) => {
  try {
    // Collect relevant environment variables for AI provider selection
    const envVars = {
      TEXT_PROVIDER: process.env.TEXT_PROVIDER,
      IMAGE_PROVIDER: process.env.IMAGE_PROVIDER,

      // Google GenAI
      GOOGLE_GENAI_API_KEY: process.env.GOOGLE_GENAI_API_KEY
        ? "***REDACTED***"
        : undefined,
      GOOGLE_GENAI_MODEL: process.env.GOOGLE_GENAI_MODEL,
      GOOGLE_GENAI_IMAGE_MODEL: process.env.GOOGLE_GENAI_IMAGE_MODEL,

      // OpenAI
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ? "***REDACTED***" : undefined,
      OPENAI_TEXT_MODEL: process.env.OPENAI_TEXT_MODEL,
      OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL,

      // Debug settings
      DEBUG_AI_FULL_PROMPTS: process.env.DEBUG_AI_FULL_PROMPTS,
      DEBUG_AI_FULL_RESPONSES: process.env.DEBUG_AI_FULL_RESPONSES,
      LOG_LEVEL: process.env.LOG_LEVEL,
    };

    // Create a test context for the AI call
    const testContext = {
      authorId: "00000000-0000-0000-0000-000000000001", // Test UUID
      storyId: "00000000-0000-0000-0000-000000000002", // Test UUID
      action: "test" as const,
    };

    let success = false;
    let response = "";
    let error = null;
    let provider = "";

    try {
      // Get the text service from the AI gateway
      const textService = aiGateway.getTextService(testContext);
      provider = process.env.TEXT_PROVIDER || "google-genai";

      // Make a basic prompt request
      response = await textService.complete(
        "Say hi and tell me you are working correctly. Keep it brief.",
        {
          maxTokens: 100,
          temperature: 0.7,
        },
      );

      success = true;
    } catch (aiError) {
      success = false;
      error = {
        message: aiError instanceof Error ? aiError.message : String(aiError),
        stack: aiError instanceof Error ? aiError.stack : undefined,
        name: aiError instanceof Error ? aiError.name : "UnknownError",
      };
    }

    res.json({
      success,
      timestamp: new Date().toISOString(),
      environment: envVars,
      testResult: {
        provider,
        response: success ? response : null,
        error: error,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      timestamp: new Date().toISOString(),
      error: {
        message: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : "UnknownError",
      },
    });
  }
});

export { router as aiRouter };
