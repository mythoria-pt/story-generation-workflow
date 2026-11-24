import { Router, type Response } from 'express';
import { z } from 'zod';
import { apiKeyAuth } from '@/middleware/apiKeyAuth.js';
import { logger } from '@/config/logger.js';
import { PremiumBookError } from '@/services/premium-book-contract.js';
import {
  advancePremiumRun,
  claimPremiumResume,
  correctPremiumSpread,
  identifyPremiumRun,
  PREMIUM_LAST_STAGE,
  premiumCorrectionRequest,
  resumePremiumRun,
} from '@/services/premium-book.js';

export const premiumBookRouter = Router();
const storyRun = z.object({ storyId: z.uuid(), runId: z.uuid() });

function errorResponse(res: Response, error: unknown, ref: string) {
  const known = error instanceof PremiumBookError;
  const provider = error as { status?: number; code?: string } | null;
  const blocked =
    provider?.status === 422 ||
    ['moderation_blocked', 'content_policy_violation'].includes(provider?.code ?? '');
  const code = known ? error.code : blocked ? 'premium_text_blocked' : 'premium_operation_failed';
  const status = known ? error.status : blocked ? 422 : 500;
  logger.warn('Premium book operation failed', { ref, status, code });
  res.status(status).json({
    error: known
      ? error.message
      : blocked
        ? 'Premium story content blocked by provider'
        : 'Premium book operation failed',
    code,
  });
}

premiumBookRouter.post('/runs/:runId/resolve', apiKeyAuth, async (req, res) => {
  const scope = storyRun.safeParse({ runId: req.params.runId, storyId: req.body?.storyId });
  const queueType = z.string().min(1).max(50).nullish().safeParse(req.body?.bookType);
  const execution = z.string().min(1).max(255).safeParse(req.body?.executionId);
  if (!scope.success || !queueType.success || !execution.success) {
    res.status(400).json({ error: 'Invalid premium generation identity' });
    return;
  }
  try {
    res.json(
      await identifyPremiumRun(
        scope.data.storyId,
        scope.data.runId,
        execution.data,
        queueType.data ?? undefined,
      ),
    );
  } catch (error) {
    errorResponse(res, error, scope.data.runId);
  }
});

premiumBookRouter.post('/runs/:runId/resume', apiKeyAuth, async (req, res) => {
  const scope = storyRun.safeParse({ runId: req.params.runId, storyId: req.body?.storyId });
  if (!scope.success) {
    res.status(400).json({ error: 'Invalid premium generation identity' });
    return;
  }
  try {
    res.status(202).json(await resumePremiumRun(scope.data.storyId, scope.data.runId));
  } catch (error) {
    errorResponse(res, error, scope.data.runId);
  }
});

premiumBookRouter.post('/runs/:runId/resume-claim', apiKeyAuth, async (req, res) => {
  const scope = storyRun
    .extend({
      updatedAt: z.string().min(1).max(100),
      executionId: z.string().min(1).max(255),
    })
    .safeParse({ ...req.body, runId: req.params.runId });
  if (!scope.success) {
    res.status(400).json({ error: 'Invalid premium generation resume identity' });
    return;
  }
  try {
    const { storyId, runId, updatedAt, executionId } = scope.data;
    res.json(await claimPremiumResume(storyId, runId, updatedAt, executionId));
  } catch (error) {
    errorResponse(res, error, scope.data.runId);
  }
});

premiumBookRouter.post('/runs/:runId/advance', apiKeyAuth, async (req, res) => {
  const scope = storyRun.safeParse({ runId: req.params.runId, storyId: req.body?.storyId });
  const stage = z.number().int().min(0).max(PREMIUM_LAST_STAGE).safeParse(req.body?.stage);
  const execution = z.string().min(1).max(255).safeParse(req.body?.executionId);
  if (!scope.success || !stage.success || !execution.success) {
    res.status(400).json({ error: 'Invalid premium generation stage' });
    return;
  }
  try {
    res.json(
      await advancePremiumRun(scope.data.storyId, scope.data.runId, stage.data, execution.data),
    );
  } catch (error) {
    errorResponse(res, error, scope.data.runId);
  }
});

premiumBookRouter.post('/stories/:storyId/corrections', apiKeyAuth, async (req, res) => {
  const story = z.uuid().safeParse(req.params.storyId);
  const correction = premiumCorrectionRequest.safeParse(req.body);
  if (!story.success || !correction.success) {
    res.status(400).json({ error: 'Invalid premium story correction' });
    return;
  }
  try {
    res.json(await correctPremiumSpread(story.data, correction.data));
  } catch (error) {
    errorResponse(res, error, story.data);
  }
});
