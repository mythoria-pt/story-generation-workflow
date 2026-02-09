/**
 * Email Asset Generation Worker
 * Generates localized HTML email templates for marketing campaigns.
 *
 * Flow:
 * 1. Generate HTML email body for the source locale using AI + reference template
 * 2. Generate a plain-text fallback from the HTML
 * 3. Translate subject, HTML body, and text body to each remaining locale
 */

import { logger } from '@/config/logger.js';
import { jobManager } from '@/services/job-manager.js';
import { PromptService } from '@/services/prompt.js';
import { getAIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking.js';
import { buildTranslatePrompt, cleanAITextOutput } from '@/services/translation.js';
import type { AICallContext } from '@/ai/token-tracking-middleware.js';

const SUPPORTED_LOCALES = ['en-US', 'pt-PT', 'es-ES', 'fr-FR', 'de-DE'] as const;

export interface EmailAssetJobParams {
  sourceLocale: string;
  subject: string;
  bodyDescription: string;
  templateHtml: string;
  campaignId: string;
  targetLocales?: string[];
}

export interface GeneratedEmailAsset {
  subject: string;
  htmlBody: string;
  textBody: string;
}

/**
 * Strip HTML tags to produce a plain-text email fallback.
 */
function htmlToPlainText(html: string): string {
  let text = html;
  // Remove style and head blocks
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
  // Replace <br> and block-level tags with newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|tr|h[1-6]|li|td)>/gi, '\n');
  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#10022;/g, '*');
  text = text.replace(/&copy;/g, '(c)');
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * Process the email asset generation job asynchronously.
 */
export async function processEmailAssetJob(
  jobId: string,
  params: EmailAssetJobParams,
): Promise<void> {
  try {
    logger.info('Starting email asset generation job', {
      jobId,
      params: { ...params, templateHtml: '[redacted]' },
    });

    const { sourceLocale, subject, bodyDescription, templateHtml, campaignId, targetLocales } =
      params;

    jobManager.updateJobStatus(jobId, 'processing');

    const aiContext: AICallContext = {
      authorId: 'admin',
      storyId: campaignId,
      action: 'email_asset_generation',
    };

    const aiGateway = getAIGatewayWithTokenTracking();
    const textService = aiGateway.getTextService(aiContext);

    const assets: Record<string, GeneratedEmailAsset> = {};

    // -----------------------------------------------------------------------
    // Step 1: Generate the source locale HTML email
    // -----------------------------------------------------------------------
    logger.info('Generating source locale email asset', { jobId, sourceLocale });

    const promptTemplate = await PromptService.loadSharedPrompt('generate-email-asset');
    const generationPrompt = PromptService.buildPrompt(promptTemplate, {
      targetLocale: sourceLocale,
      emailSubject: subject,
      bodyDescription,
      referenceTemplate: templateHtml,
    });

    const sourceHtmlRaw = await textService.complete(generationPrompt, {
      temperature: 0.4,
    });
    const sourceHtml = cleanAITextOutput(sourceHtmlRaw);
    const sourceTextBody = htmlToPlainText(sourceHtml);

    assets[sourceLocale] = {
      subject,
      htmlBody: sourceHtml,
      textBody: sourceTextBody,
    };

    logger.info('Source locale email asset generated', {
      jobId,
      sourceLocale,
      htmlLength: sourceHtml.length,
      textLength: sourceTextBody.length,
    });

    // -----------------------------------------------------------------------
    // Step 2: Translate to each remaining locale
    // -----------------------------------------------------------------------
    const requestedLocales =
      targetLocales && targetLocales.length > 0 ? targetLocales : [...SUPPORTED_LOCALES];
    const localeSet = new Set(requestedLocales);
    localeSet.add(sourceLocale);
    const targetLocaleList = Array.from(localeSet).filter((locale) => locale !== sourceLocale);

    for (const targetLocale of targetLocaleList) {
      try {
        logger.info('Translating email asset', { jobId, targetLocale });

        // Translate subject
        const subjectPrompt = await buildTranslatePrompt(targetLocale, {
          contentType: 'title',
          originalText: subject,
          sourceLocale,
        });
        const translatedSubjectRaw = await textService.complete(subjectPrompt, {
          temperature: 0.2,
        });
        const translatedSubject = cleanAITextOutput(translatedSubjectRaw);

        // Translate HTML body (preserving structure)
        const htmlPrompt = await buildTranslatePrompt(targetLocale, {
          contentType: 'html',
          originalText: sourceHtml,
          sourceLocale,
        });
        const translatedHtmlRaw = await textService.complete(htmlPrompt, {
          temperature: 0.2,
        });
        const translatedHtml = cleanAITextOutput(translatedHtmlRaw);

        // Generate plain-text fallback from translated HTML
        const translatedTextBody = htmlToPlainText(translatedHtml);

        assets[targetLocale] = {
          subject: translatedSubject,
          htmlBody: translatedHtml,
          textBody: translatedTextBody,
        };

        logger.info('Email asset translated', {
          jobId,
          targetLocale,
          htmlLength: translatedHtml.length,
          textLength: translatedTextBody.length,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('Email asset translation failed for locale', {
          jobId,
          targetLocale,
          error: msg,
        });
        // Store partial failure; the admin can still use the successfully generated locales
        assets[targetLocale] = {
          subject: `[TRANSLATION FAILED] ${subject}`,
          htmlBody: `<!-- Translation to ${targetLocale} failed: ${msg} -->`,
          textBody: `[Translation to ${targetLocale} failed: ${msg}]`,
        };
      }
    }

    // -----------------------------------------------------------------------
    // Step 3: Mark job as completed
    // -----------------------------------------------------------------------
    const result = {
      success: true,
      type: 'email_asset_generation' as const,
      campaignId,
      sourceLocale,
      localesGenerated: Object.keys(assets),
      assets,
      timestamp: new Date().toISOString(),
    };

    jobManager.updateJobStatus(jobId, 'completed', result);

    logger.info('Email asset generation job completed', {
      jobId,
      campaignId,
      localesGenerated: Object.keys(assets).length,
    });
  } catch (error) {
    logger.error('Email asset generation job failed', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });

    jobManager.updateJobStatus(
      jobId,
      'failed',
      undefined,
      error instanceof Error ? error.message : 'Email asset generation failed',
    );
  }
}
