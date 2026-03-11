import express from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { PrintGenerationHandler } from '@/workflows/handlers.js';
import { logger } from '@/config/logger.js';
import { StoryService } from '@/services/story.js';
import { RunsService } from '@/services/runs.js';
import { GoogleCloudWorkflowsAdapter } from '@/adapters/google-cloud/workflows-adapter.js';
import { MythoriaAdminClient } from '@/services/mythoria-admin-client.js';
import { PrintQualityService } from '@/services/print-quality.js';
import {
  SelfPrintDelivery,
  SelfPrintRecipient,
  SelfPrintWorkflowPayload,
} from '@/types/self-print.js';
import {
  sendPrintQaCriticalEmail,
  sendStoryPrintInstructionsEmail,
} from '@/services/notification-client.js';
import type { PrintQaAssetUrls } from '@/types/print-quality.js';

export const printRouter = express.Router();
export const internalPrintRouter = express.Router();

const storyService = new StoryService();
const runsService = new RunsService();
const workflowsAdapter = new GoogleCloudWorkflowsAdapter();
const printGenerationHandler = new PrintGenerationHandler();
const printQualityService = new PrintQualityService();
const mythoriaAdminClient = new MythoriaAdminClient();

const RecipientSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  locale: z.string().optional(),
});

const SelfPrintRequestSchema = z.object({
  storyId: z.string().uuid(),
  workflowId: z.string().uuid().optional(),
  recipientEmail: z.string().email().optional(),
  recipients: z.array(RecipientSchema).optional(),
  includeAuthorEmail: z.boolean().optional(),
  ccEmails: z.array(z.string().email()).optional(),
  locale: z.string().optional(),
  generateCMYK: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const PrintResultSchema = z.object({
  interiorPdfUrl: z.string().url(),
  coverPdfUrl: z.string().url(),
  interiorCmykPdfUrl: z.string().url().nullable().optional(),
  coverCmykPdfUrl: z.string().url().nullable().optional(),
});

const PrintQaIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(['warning', 'critical']),
  chapterNumber: z.number().optional(),
  pageNumbers: z.array(z.number()).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  suggestedFix: z.string().optional(),
});

const PrintQaFixAppliedSchema = z.object({
  chapterNumber: z.number(),
  strategy: z.string(),
  layoutOverride: z
    .object({
      marginLeftMM: z.number().optional(),
      marginRightMM: z.number().optional(),
      lineHeightPt: z.number().optional(),
      paragraphSpacingPt: z.number().optional(),
    })
    .optional(),
});

const QualityCheckRequestSchema = z.object({
  storyId: z.string().uuid(),
  runId: z.string().uuid(),
  printResult: PrintResultSchema,
});

const QualityAlertRequestSchema = z.object({
  storyId: z.string().uuid(),
  runId: z.string().uuid(),
  reportUrl: z.string().url().nullable().optional(),
  printResult: PrintResultSchema,
  criticalErrors: z.array(PrintQaIssueSchema),
  fixesApplied: z.array(PrintQaFixAppliedSchema).optional(),
});

function dedupeRecipients(recipients: SelfPrintRecipient[]): SelfPrintRecipient[] {
  const seen = new Map<string, SelfPrintRecipient>();
  for (const recipient of recipients) {
    if (!recipient.email) {
      continue;
    }
    const key = recipient.email.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, recipient);
    }
  }
  return Array.from(seen.values());
}

printRouter.post('/self-service', async (req, res) => {
  const parsed = SelfPrintRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: 'Invalid request payload',
      details: parsed.error.flatten(),
    });
    return;
  }

  const {
    storyId,
    workflowId: providedWorkflowId,
    recipientEmail,
    recipients,
    includeAuthorEmail,
    ccEmails,
    locale,
    generateCMYK,
    metadata,
  } = parsed.data;

  const workflowId = providedWorkflowId ?? randomUUID();

  try {
    const story = await storyService.getStory(storyId);
    if (!story) {
      res.status(404).json({ success: false, error: 'Story not found' });
      return;
    }

    const resolvedRecipients: SelfPrintRecipient[] = [];
    const shouldIncludeAuthor = includeAuthorEmail ?? true;
    if (shouldIncludeAuthor && story.authorEmail) {
      const authorRecipient: SelfPrintRecipient = { email: story.authorEmail };
      if (story.author) authorRecipient.name = story.author;
      if (story.authorPreferredLocale) authorRecipient.locale = story.authorPreferredLocale;
      resolvedRecipients.push(authorRecipient);
    }

    if (recipients?.length) {
      const validRecipients = recipients.map((r) => {
        const recipient: SelfPrintRecipient = { email: r.email };
        if (r.name) recipient.name = r.name;
        if (r.locale) recipient.locale = r.locale;
        return recipient;
      });
      resolvedRecipients.push(...validRecipients);
    }
    if (recipientEmail) {
      resolvedRecipients.push({ email: recipientEmail });
    }

    const dedupedRecipients = dedupeRecipients(resolvedRecipients);
    if (dedupedRecipients.length === 0) {
      res.status(400).json({ success: false, error: 'No valid recipients provided' });
      return;
    }

    const delivery: SelfPrintDelivery = {
      recipients: dedupedRecipients,
      locale: locale ?? story.authorPreferredLocale ?? story.storyLanguage ?? 'en-US',
      metadata: {
        ...(metadata || {}),
        serviceCode: 'selfPrinting',
        storyTitle: story.title,
        initiatedBy: 'selfService',
        origin: 'self-service',
      },
      requestedBy: {
        authorId: story.authorId,
        email: story.authorEmail,
        name: story.author,
      },
    };
    if (ccEmails && ccEmails.length) {
      const dedupedCc = Array.from(
        new Map(ccEmails.map((email) => [email.toLowerCase(), email])).values(),
      );
      if (dedupedCc.length) {
        delivery.ccEmails = dedupedCc;
      }
    }

    const workflowPayload: SelfPrintWorkflowPayload = {
      storyId,
      runId: workflowId,
      generateCMYK: generateCMYK !== false,
      delivery,
      initiatedBy: 'selfService',
      origin: 'self-service',
    };

    const workflowEvent = {
      data: {
        message: {
          data: Buffer.from(JSON.stringify(workflowPayload)).toString('base64'),
        },
      },
    };

    const executionId = await workflowsAdapter.executeWorkflow('print-generation', workflowEvent);

    const existingRun = await runsService.createOrGetRun(storyId, workflowId, executionId);
    const mergedMetadata: Record<string, unknown> = {
      ...(existingRun?.metadata && typeof existingRun.metadata === 'object'
        ? (existingRun.metadata as Record<string, unknown>)
        : {}),
      delivery,
      serviceCode: 'selfPrinting',
      origin: 'self-service',
      workflowExecutionId: executionId,
    };

    await runsService.updateRun(workflowId, {
      status: 'queued',
      currentStep: 'self_print_requested',
      metadata: mergedMetadata,
    });

    logger.info('Self-print workflow enqueued', {
      storyId,
      workflowId,
      executionId,
      recipientCount: dedupedRecipients.length,
    });

    res.status(202).json({
      success: true,
      message: 'Self-print workflow started',
      storyId,
      workflowId,
      executionId,
      recipients: dedupedRecipients.map((recipient) => recipient.email),
    });
  } catch (error) {
    logger.error('Failed to start self-print workflow', {
      storyId,
      workflowId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to start print workflow' });
  }
});

// Internal print generation endpoint (existing workflow hook)
internalPrintRouter.post(
  '/generate',
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const { storyId, workflowId, generateCMYK } = req.body;

      if (!storyId || !workflowId) {
        res.status(400).json({
          error: 'Missing required fields',
          required: ['storyId', 'workflowId'],
        });
        return;
      }

      logger.info('Print generation request received', { storyId, workflowId });

      const result = await printGenerationHandler.execute({ storyId, workflowId, generateCMYK });

      res.json(result);
    } catch (error) {
      logger.error('Print generation failed:', error);
      res.status(500).json({
        error: 'Print generation failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

const NotifyRequestSchema = z.object({
  storyId: z.string().uuid(),
  runId: z.string().uuid(),
  initiatedBy: z.string().optional(),
  origin: z.string().optional(),
  delivery: z
    .object({
      recipients: z.array(RecipientSchema).optional(),
      locale: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      ccEmails: z.array(z.string().email()).optional(),
    })
    .optional(),
  printResult: PrintResultSchema,
});

internalPrintRouter.post('/quality-check', async (req, res) => {
  const parsed = QualityCheckRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid request payload' });
    return;
  }

  const normalizedPrintResult = {
    interiorPdfUrl: parsed.data.printResult.interiorPdfUrl,
    coverPdfUrl: parsed.data.printResult.coverPdfUrl,
    ...(parsed.data.printResult.interiorCmykPdfUrl !== undefined
      ? { interiorCmykPdfUrl: parsed.data.printResult.interiorCmykPdfUrl }
      : {}),
    ...(parsed.data.printResult.coverCmykPdfUrl !== undefined
      ? { coverCmykPdfUrl: parsed.data.printResult.coverCmykPdfUrl }
      : {}),
  };

  try {
    const result = await printQualityService.execute({
      storyId: parsed.data.storyId,
      runId: parsed.data.runId,
      printResult: normalizedPrintResult,
    });
    res.json(result);
  } catch (error) {
    logger.error('Unexpected error in print quality-check route', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.json({
      qaStatus: 'review_failed',
      reportUrl: null,
      passCount: 0,
      warningCount: 0,
      criticalCount: 1,
      alertNeeded: true,
      fixesApplied: [],
      criticalErrors: [
        {
          code: 'print_qa_route_failed',
          severity: 'critical',
          message: 'The print QA route failed before the quality report could be returned.',
          suggestedFix: 'Inspect the internal print QA logs and retry the workflow.',
        },
      ],
      warnings: [],
      printResult: parsed.data.printResult,
    });
  }
});

internalPrintRouter.post('/quality-alert', async (req, res) => {
  const parsed = QualityAlertRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid request payload' });
    return;
  }

  const { storyId, runId, reportUrl, printResult, criticalErrors, fixesApplied } = parsed.data;

  try {
    const [story, managers] = await Promise.all([
      storyService.getStory(storyId),
      mythoriaAdminClient.getManagers(),
    ]);

    if (!story) {
      logger.warn('Story not found for print QA alert', { storyId, runId });
      res.json({ sent: false, recipientCount: 0, reason: 'story_not_found' });
      return;
    }

    const recipients = managers.map((manager) => ({
      email: manager.email,
      name: manager.name,
      language: 'en-US',
    }));

    if (recipients.length === 0) {
      logger.warn('No admin recipients available for print QA alert', { storyId, runId });
      res.json({ sent: false, recipientCount: 0, reason: 'no_recipients' });
      return;
    }

    const sent = await sendPrintQaCriticalEmail({
      storyId,
      storyTitle: story.title,
      runId,
      reportUrl: reportUrl ?? null,
      recipientCount: recipients.length,
      recipients,
      criticalErrors: criticalErrors.map((issue) => ({
        code: issue.code,
        message: issue.message,
        ...(issue.chapterNumber !== undefined ? { chapterNumber: issue.chapterNumber } : {}),
        ...(issue.pageNumbers !== undefined ? { pageNumbers: issue.pageNumbers } : {}),
        ...(issue.suggestedFix ? { suggestedFix: issue.suggestedFix } : {}),
      })),
      fixesApplied: (fixesApplied ?? []).map((fix) => ({
        chapterNumber: fix.chapterNumber,
        strategy: fix.strategy,
      })),
      printResult: printResult as PrintQaAssetUrls,
      metadata: {
        storyId,
        runId,
      },
    });

    res.json({
      sent,
      recipientCount: recipients.length,
    });
  } catch (error) {
    logger.error('Failed to dispatch print QA alert', {
      storyId,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.json({ sent: false, recipientCount: 0, reason: 'unexpected_error' });
  }
});

internalPrintRouter.post('/self-service/notify', async (req, res) => {
  const parsed = NotifyRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid request payload' });
    return;
  }

  const { storyId, runId, delivery, printResult, initiatedBy, origin } = parsed.data;

  const originFromMetadata =
    typeof delivery?.metadata?.origin === 'string'
      ? (delivery?.metadata?.origin as string)
      : undefined;

  const resolvedInitiatedBy =
    initiatedBy ??
    (delivery?.metadata?.initiatedBy as string | undefined) ??
    (origin === 'admin'
      ? 'adminPortal'
      : origin === 'self-service'
        ? 'selfService'
        : 'selfService');

  const resolvedOrigin =
    origin ??
    originFromMetadata ??
    (resolvedInitiatedBy === 'adminPortal'
      ? 'admin'
      : resolvedInitiatedBy === 'selfService'
        ? 'self-service'
        : 'self-service');

  const resolvedServiceCode =
    (delivery?.metadata?.serviceCode as string | undefined) ??
    (resolvedOrigin === 'admin' ? 'printGeneration' : 'selfPrinting');

  const recipients = delivery?.recipients ?? [];
  const hasRecipients = recipients.length > 0;
  const shouldSendInstructions = hasRecipients && resolvedOrigin === 'self-service';

  try {
    const run = await runsService.getRun(runId);
    const executionId =
      (delivery?.metadata?.workflowExecutionId as string | undefined) ||
      (run?.gcpWorkflowExecution ?? undefined);

    const story = await storyService.getStory(storyId);
    if (!story) {
      logger.error('Story not found for self-print notification', { storyId, runId });
      res.json({ success: false, reason: 'story_not_found' });
      return;
    }

    await runsService.updateRun(runId, {
      metadata: {
        serviceCode: resolvedServiceCode,
        initiatedBy: resolvedInitiatedBy,
        origin: resolvedOrigin,
      },
    });

    if (!shouldSendInstructions) {
      logger.info('Self-print notification suppressed', {
        storyId,
        runId,
        initiatedBy: resolvedInitiatedBy,
        origin: resolvedOrigin,
        reason: hasRecipients ? 'admin_initiated' : 'no_recipients',
      });
      res.json({
        success: true,
        reason: resolvedOrigin === 'admin' ? 'suppressed_for_admin' : 'no_recipients',
      });
      return;
    }

    const deliveryPayload = delivery as NonNullable<typeof delivery>;
    const [primaryRecipient, ...extraRecipients] = recipients;
    if (!primaryRecipient) {
      logger.error('No primary recipient found for self-print notification', { storyId, runId });
      res.json({ success: false, reason: 'no_recipients' });
      return;
    }
    const normalizedRecipient: { email: string; name?: string; language?: string } = {
      email: primaryRecipient.email,
    };
    if (primaryRecipient.name) {
      normalizedRecipient.name = primaryRecipient.name;
    }
    if (primaryRecipient.locale) {
      normalizedRecipient.language = primaryRecipient.locale;
    }

    const ccFromRecipients = extraRecipients.map((recipient) => {
      const ccEntry: { email: string; name?: string; language?: string } = {
        email: recipient.email,
      };
      if (recipient.name) {
        ccEntry.name = recipient.name;
      }
      if (recipient.locale) {
        ccEntry.language = recipient.locale;
      }
      return ccEntry;
    });

    const ccFromDeliveryEmails = (deliveryPayload.ccEmails || []).map((email) => ({ email }));

    const dedupeRecipients = (
      entries: Array<{ email: string; name?: string; language?: string }>,
    ) => {
      const map = new Map<string, { email: string; name?: string; language?: string }>();
      for (const entry of entries) {
        const key = entry.email.toLowerCase();
        if (!map.has(key)) {
          map.set(key, entry);
        }
      }
      return Array.from(map.values());
    };

    const ccRecipients = dedupeRecipients([...ccFromRecipients, ...ccFromDeliveryEmails]);

    const sendResult = await sendStoryPrintInstructionsEmail({
      storyId,
      storyTitle: story.title,
      workflowId: runId,
      recipient: normalizedRecipient,
      cc: ccRecipients.length > 0 ? ccRecipients : [],
      storyLanguage: story.storyLanguage,
      locale: deliveryPayload.locale ?? story.storyLanguage ?? primaryRecipient?.locale ?? 'en-US',
      metadata: {
        ...(deliveryPayload.metadata || {}),
        runId,
        serviceCode: resolvedServiceCode,
        workflowExecutionId: executionId,
        origin: resolvedOrigin,
        requestedByName:
          (deliveryPayload.metadata?.requestedBy as string | undefined) ||
          (deliveryPayload.metadata?.requestedByName as string | undefined),
      },
      origin: resolvedOrigin,
      pdfs: {
        interiorPdfUrl: printResult.interiorPdfUrl,
        coverPdfUrl: printResult.coverPdfUrl,
        interiorCmykPdfUrl: printResult.interiorCmykPdfUrl ?? null,
        coverCmykPdfUrl: printResult.coverCmykPdfUrl ?? null,
      },
    });

    logger.info('Self-print notification dispatched', {
      storyId,
      runId,
      executionId,
      sent: sendResult,
      recipientCount: 1,
      ccCount: ccRecipients.length,
    });

    res.json({ success: sendResult, recipients: recipients.length });
  } catch (error) {
    logger.error('Failed to send self-print notification', {
      storyId,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.json({ success: false, reason: 'unexpected_error' });
  }
});
