import express from 'express';
import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'node:util';
import apiKeyAuth from '@/middleware/apiKeyAuth.js';
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
import { eq } from 'drizzle-orm';
import { getDatabase } from '@/db/connection.js';
import { productGenerationRequests } from '@/db/schema/index.js';
import { hasPremiumMarker, readPremiumMarker } from '@/services/premium-book-contract.js';
import { publishedPremium } from '@/services/premium-order-proof.js';
import { premiumAdminPrintRouter } from './premium-admin-print.js';
import {
  findPremiumSelfPrintFunding,
  premiumSelfPrintSource,
  readPremiumSelfPrintSource,
  renderPremiumSelfPrint,
  signPremiumSelfPrint,
} from '@/services/premium-self-print.js';

export const printRouter = express.Router();
export const internalPrintRouter = express.Router();
internalPrintRouter.use('/premium-admin', premiumAdminPrintRouter);

internalPrintRouter.post('/order-proof', apiKeyAuth, async (req, res) => {
  const { OrderProofRequest, prepareOrderProof } = await import('@/services/order-proof.js');
  const parsed = OrderProofRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid print proof request' });
    return;
  }
  try {
    res.json(await prepareOrderProof(parsed.data));
  } catch (error) {
    logger.error('Paid print proof preparation failed', {
      orderId: parsed.data.orderId,
      runId: parsed.data.runId,
      errorType: error instanceof Error ? error.name : 'unknown',
    });
    res.status(500).json({ error: 'Print proof preparation failed' });
  }
});

const storyService = new StoryService();
const runsService = new RunsService();
const workflowsAdapter = new GoogleCloudWorkflowsAdapter();
const printGenerationHandler = new PrintGenerationHandler();
const printQualityService = new PrintQualityService();
const mythoriaAdminClient = new MythoriaAdminClient();
const sharedDb = getDatabase();

const updateSelfPrintDeliveryStatus = async (runId: string, deliveryStatus: string) => {
  await sharedDb
    .update(productGenerationRequests)
    .set({ deliveryStatus, updatedAt: new Date() })
    .where(eq(productGenerationRequests.runId, runId));
};

const RecipientSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  locale: z.string().optional(),
});

const NotificationDeliverySchema = z.object({
  recipients: z.array(RecipientSchema).optional(),
  locale: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  ccEmails: z.array(z.string().email()).optional(),
});

const ReservedPrintPayload = z
  .object({
    storyId: z.uuid(),
    runId: z.uuid(),
    premiumSelfPrint: z.literal(true),
    delivery: z
      .object({
        recipients: z.array(RecipientSchema).min(1),
      })
      .passthrough(),
  })
  .passthrough();

function readReservedPrintPayload(metadata: unknown) {
  return metadata && typeof metadata === 'object' && 'premiumSelfPrintDispatch' in metadata
    ? ReservedPrintPayload.parse(metadata.premiumSelfPrintDispatch)
    : undefined;
}

const SelfPrintRequestSchema = z.object({
  storyId: z.string().uuid(),
  workflowId: z.string().uuid().optional(),
  recipientEmail: z.string().email().optional(),
  recipients: z.array(RecipientSchema).optional(),
  includeAuthorEmail: z.boolean().optional(),
  ccEmails: z.array(z.string().email()).optional(),
  locale: z.string().optional(),
  generateCMYK: z.boolean().optional(),
  premiumBook: publishedPremium.optional(),
  skipQA: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const PrintGenerateRequestSchema = z.object({
  storyId: z.string().uuid(),
  workflowId: z.string().uuid(),
  generateCMYK: z.boolean().optional(),
  skipQA: z.boolean().optional(),
  executionId: z.string().min(1).max(255).nullable().optional(),
});

const PrintResultSchema = z.object({
  interiorPdfUrl: z.string().url(),
  coverPdfUrl: z.string().url(),
  interiorCmykPdfUrl: z.string().url().nullable().optional(),
  coverCmykPdfUrl: z.string().url().nullable().optional(),
  premiumRevision: z.uuid().optional(),
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

function authorizePremiumPrintExecution(
  req: express.Request,
  res: express.Response,
  expected: string | null | undefined,
  actual: string | null | undefined,
) {
  let authorized = false;
  apiKeyAuth(req, res, () => {
    authorized = true;
  });
  if (!authorized) return false;
  if (!expected || expected !== actual) {
    res.status(409).json({ error: 'Premium self-print execution has been superseded' });
    return false;
  }
  return true;
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
    premiumBook,
    skipQA,
    metadata,
  } = parsed.data;

  const workflowId = providedWorkflowId ?? randomUUID();

  try {
    const story = await storyService.getStory(storyId);
    if (!story) {
      res.status(404).json({ success: false, error: 'Story not found' });
      return;
    }

    const storedEdition = readPremiumMarker(story.features);
    let premiumSource: z.infer<typeof premiumSelfPrintSource> | undefined;
    if (storedEdition || premiumBook) {
      if (
        story.status !== 'published' ||
        metadata?.requestedByAuthorId !== story.authorId ||
        !premiumBook ||
        storedEdition?.state !== 'published' ||
        storedEdition.ownerId !== story.authorId
      ) {
        res.status(409).json({ success: false, error: 'Premium self-print edition unavailable' });
        return;
      }
      premiumSource = premiumSelfPrintSource.parse({
        ownerId: story.authorId,
        revision: premiumBook.revision,
        manifest: premiumBook.manifest,
        generateCMYK: generateCMYK !== false,
      });
      const accepted = await runsService.getRun(workflowId);
      const storedSource = readPremiumSelfPrintSource(accepted?.metadata);
      if (
        (accepted &&
          (accepted.storyId !== storyId ||
            !storedSource ||
            !isDeepStrictEqual(storedSource, premiumSource))) ||
        !(await findPremiumSelfPrintFunding(storyId, workflowId, premiumSource, Boolean(accepted)))
      ) {
        res
          .status(409)
          .json({ success: false, error: 'Premium self-print funding or edition mismatch' });
        return;
      }
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
      ...(premiumSource ? { premiumSelfPrint: true } : {}),
      ...(skipQA === true ? { skipQA: true } : {}),
    };

    const reservation = premiumSource
      ? await runsService.reserveRun(storyId, workflowId, {
          premiumSelfPrint: premiumSource,
          premiumSelfPrintDispatch: workflowPayload,
          serviceCode: 'selfPrinting',
        })
      : await runsService.reserveRun(storyId, workflowId);

    const reservedPayload =
      premiumSource && !reservation.reserved
        ? readReservedPrintPayload(reservation.run.metadata)
        : undefined;
    if (
      reservedPayload &&
      (reservedPayload.storyId !== storyId || reservedPayload.runId !== workflowId)
    ) {
      res
        .status(409)
        .json({ success: false, error: 'Premium self-print dispatch identity mismatch' });
      return;
    }
    const resolvedPayload = reservedPayload ?? workflowPayload;
    const resolvedEmails = resolvedPayload.delivery?.recipients.map(({ email }) => email) ?? [];
    if (!reservation.reserved) {
      if (reservation.run.status === 'failed') {
        res.status(409).json({ success: false, error: 'Print workflow already failed' });
        return;
      }
      if (
        !reservedPayload ||
        reservation.run.gcpWorkflowExecution ||
        !(await runsService.reclaimSelfPrintDispatch(workflowId))
      ) {
        res.status(202).json({
          success: true,
          message: 'Self-print workflow already started',
          storyId,
          workflowId,
          executionId: reservation.run.gcpWorkflowExecution || '',
          recipients: resolvedEmails,
        });
        return;
      }
    }

    const workflowEvent = {
      data: { message: { data: Buffer.from(JSON.stringify(resolvedPayload)).toString('base64') } },
    };

    let executionId: string;
    try {
      executionId = await workflowsAdapter.executeWorkflow('print-generation', workflowEvent);
      if (premiumSource && !executionId)
        throw new Error('Premium self-print dispatch is unconfirmed');
    } catch (error) {
      if (!premiumSource)
        await runsService
          .updateRun(workflowId, {
            status: 'failed',
            currentStep: 'queue',
            failureStage: 'queue',
            failureCode: 'workflow_enqueue_failed',
            errorMessage: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      throw error;
    }

    const mergedMetadata: Record<string, unknown> = {
      delivery,
      serviceCode: 'selfPrinting',
      origin: 'self-service',
      workflowExecutionId: executionId,
    };

    try {
      if (premiumSource)
        executionId = await runsService.linkSelfPrintExecution(workflowId, executionId);
      else
        await runsService.updateRun(workflowId, {
          gcpWorkflowExecution: executionId,
          metadata: mergedMetadata,
        });
    } catch (error) {
      logger.warn('Self-print workflow started but its execution reference was not persisted', {
        workflowRef: workflowId.slice(0, 8),
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info('Self-print workflow enqueued', {
      workflowRef: workflowId.slice(0, 8),
      recipientCount: dedupedRecipients.length,
    });

    res.status(202).json({
      success: true,
      message: 'Self-print workflow started',
      storyId,
      workflowId,
      executionId,
      recipients: resolvedEmails,
    });
  } catch (error) {
    logger.error('Failed to start self-print workflow', {
      workflowRef: workflowId.slice(0, 8),
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to start print workflow' });
  }
});

// Internal print generation endpoint (existing workflow hook)
internalPrintRouter.post(
  '/generate',
  async (req: express.Request, res: express.Response): Promise<void> => {
    const parsed = PrintGenerateRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid request payload',
        details: parsed.error.flatten(),
      });
      return;
    }

    const { storyId, workflowId, generateCMYK, skipQA, executionId } = parsed.data;

    try {
      logger.info('Print generation request received', { storyId, workflowId, skipQA });

      const run = await runsService.getRun(workflowId);
      if (run && run.storyId !== storyId) {
        res.status(409).json({ error: 'Print run does not belong to this story' });
        return;
      }
      const source = readPremiumSelfPrintSource(run?.metadata);
      if (source) {
        if (!authorizePremiumPrintExecution(req, res, run?.gcpWorkflowExecution, executionId))
          return;
        if (
          run?.status !== 'running' ||
          !(await findPremiumSelfPrintFunding(storyId, workflowId, source, true))
        ) {
          res.status(409).json({ error: 'Premium self-print run is unavailable' });
          return;
        }
        res.json(await renderPremiumSelfPrint(storyId, workflowId, source));
        return;
      }

      const result = await printGenerationHandler.execute({
        storyId,
        workflowId,
        ...(generateCMYK !== undefined ? { generateCMYK } : {}),
        ...(skipQA !== undefined ? { skipQA } : {}),
      });

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
  executionId: z.string().min(1).max(255).nullable().optional(),
  delivery: NotificationDeliverySchema.optional(),
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
      storyId: parsed.data.storyId,
      runId: parsed.data.runId,
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
      mythoriaAdminClient.getManagers().catch((error: unknown) => {
        logger.error('Print QA manager lookup failed', {
          event: 'print_qa_alert_attempt_failed',
          reason: 'manager_lookup_failed',
          storyId,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }),
    ]);

    if (!story) {
      logger.warn('Story not found for print QA alert', { storyId, runId });
      res.json({ sent: false, recipientCount: 0, reason: 'story_not_found' });
      return;
    }

    if (managers === null) {
      res.status(502).json({ sent: false, recipientCount: 0, reason: 'manager_lookup_failed' });
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

    const deliveryStatus = await sendPrintQaCriticalEmail({
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

    if (deliveryStatus === 'sent') {
      res.json({ sent: true, recipientCount: recipients.length });
      return;
    }

    const reason = {
      accepted: 'dispatch_accepted',
      partial: 'dispatch_partial',
      failed: 'dispatch_failed',
      unknown: 'dispatch_unknown',
    }[deliveryStatus];
    logger.error('Print QA notification delivery was not confirmed for every recipient', {
      event: 'print_qa_alert_attempt_failed',
      reason,
      storyId,
      runId,
      recipientCount: recipients.length,
    });
    // The engine can have delivered to some managers even when its response
    // is inconclusive. Retrying the whole request can resend their alerts.
    res.json({ sent: false, recipientCount: recipients.length, reason });
  } catch (error) {
    logger.error('Failed to dispatch print QA alert', {
      event: 'print_qa_alert_attempt_failed',
      reason: 'unexpected_error',
      storyId,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ sent: false, recipientCount: 0, reason: 'unexpected_error' });
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
    const source = readPremiumSelfPrintSource(run?.metadata);
    if (source || printResult.premiumRevision) {
      if (
        !authorizePremiumPrintExecution(
          req,
          res,
          run?.gcpWorkflowExecution,
          parsed.data.executionId,
        )
      )
        return;
      const reserved = readReservedPrintPayload(run?.metadata);
      if (
        !source ||
        run?.storyId !== storyId ||
        run.status !== 'completed' ||
        source.revision !== printResult.premiumRevision ||
        !reserved ||
        reserved.storyId !== storyId ||
        reserved.runId !== runId ||
        !isDeepStrictEqual(NotificationDeliverySchema.parse(reserved.delivery), delivery) ||
        !(await findPremiumSelfPrintFunding(storyId, runId, source, true))
      ) {
        res.status(409).json({ error: 'Premium self-print delivery does not match its run' });
        return;
      }
    }
    const executionId =
      (delivery?.metadata?.workflowExecutionId as string | undefined) ||
      (run?.gcpWorkflowExecution ?? undefined);

    const story = await storyService.getStory(storyId);
    if (!story) {
      logger.error('Story not found for self-print notification', { storyId, runId });
      await updateSelfPrintDeliveryStatus(runId, 'failed');
      res.json({ success: false, deliveryStatus: 'failed', reason: 'story_not_found' });
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
      await updateSelfPrintDeliveryStatus(runId, 'not_required');
      logger.info('Self-print notification suppressed', {
        storyId,
        runId,
        initiatedBy: resolvedInitiatedBy,
        origin: resolvedOrigin,
        reason: hasRecipients ? 'admin_initiated' : 'no_recipients',
      });
      res.json({
        success: true,
        deliveryStatus: 'not_requested',
        reason: resolvedOrigin === 'admin' ? 'suppressed_for_admin' : 'no_recipients',
      });
      return;
    }

    const deliveryPayload = delivery as NonNullable<typeof delivery>;
    const [primaryRecipient, ...extraRecipients] = recipients;
    if (!primaryRecipient) {
      logger.error('No primary recipient found for self-print notification', { storyId, runId });
      await updateSelfPrintDeliveryStatus(runId, 'failed');
      res.json({ success: false, deliveryStatus: 'failed', reason: 'no_recipients' });
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

    let pdfs = printResult;
    if (source) pdfs = await signPremiumSelfPrint(storyId, runId, source.revision);
    else if (hasPremiumMarker(story.features))
      throw new Error('Premium self-print delivery lacks its reserved edition');

    const deliveryStatus = await sendStoryPrintInstructionsEmail({
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
      ...(printResult.premiumRevision ? { premiumRevision: printResult.premiumRevision } : {}),
      pdfs: {
        interiorPdfUrl: pdfs.interiorPdfUrl,
        coverPdfUrl: pdfs.coverPdfUrl,
        interiorCmykPdfUrl: pdfs.interiorCmykPdfUrl ?? null,
        coverCmykPdfUrl: pdfs.coverCmykPdfUrl ?? null,
      },
    });

    logger.info('Self-print notification dispatched', {
      storyId,
      runId,
      executionId,
      deliveryStatus,
      recipientCount: 1,
      ccCount: ccRecipients.length,
    });

    const storedDeliveryStatuses = {
      sent: 'delivered',
      accepted: 'pending',
      failed: 'failed',
      not_requested: 'not_required',
      unknown: 'unknown',
    };
    await updateSelfPrintDeliveryStatus(runId, storedDeliveryStatuses[deliveryStatus]).catch(
      (error: unknown) => {
        logger.error('Failed to persist self-print delivery status', { storyId, runId, error });
      },
    );

    res.json({
      success: deliveryStatus === 'sent' || deliveryStatus === 'accepted',
      deliveryStatus,
      recipients: recipients.length,
    });
  } catch (error) {
    await updateSelfPrintDeliveryStatus(runId, 'failed').catch(() => undefined);
    logger.error('Failed to send self-print notification', {
      storyId,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.json({ success: false, deliveryStatus: 'failed', reason: 'unexpected_error' });
  }
});
