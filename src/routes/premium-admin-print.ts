import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { logger } from '@/config/logger.js';
import apiKeyAuth from '@/middleware/apiKeyAuth.js';
import {
  getAdminPremiumPrintStatus,
  markAdminPremiumPrintWorkerLost,
  PremiumAdminPrintError,
  runAdminPremiumPrint,
  signAdminPremiumPrint,
} from '@/services/premium-admin-print.js';
import { premiumPrintPart } from '@/services/premium-self-print.js';

export const premiumAdminPrintRouter = express.Router();
premiumAdminPrintRouter.use(apiKeyAuth, (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});

const edition = z.object({ storyId: z.uuid().toLowerCase(), revision: z.uuid().toLowerCase() });
const download = edition.extend({ runId: z.uuid().toLowerCase(), part: premiumPrintPart });
const worker = edition.extend({
  runId: z.uuid(),
  attemptId: z.uuid(),
  executionId: z.string().min(1).max(128),
});

function adminPrintAuth(req: Request, res: Response, next: NextFunction) {
  const expected = Buffer.from(process.env.MYTHORIA_ADMIN_API_KEY?.trim() ?? '');
  const provided = Buffer.from(req.header('x-admin-api-key')?.trim() ?? '');
  if (
    !expected.length ||
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function printError(res: Response, error: unknown) {
  if (error instanceof PremiumAdminPrintError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  logger.error('Premium Admin print request failed', {
    errorType: error instanceof Error ? error.name : 'unknown',
  });
  res.status(500).json({ error: 'Premium print export unavailable' });
}

function workerHandler(operation: typeof runAdminPremiumPrint): express.RequestHandler {
  return async (req, res) => {
    const input = worker.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Invalid export attempt' });
      return;
    }
    const { runId, attemptId, executionId, ...params } = input.data;
    try {
      await operation(params, runId, attemptId, executionId);
      res.sendStatus(204);
    } catch (error) {
      printError(res, error);
    }
  };
}

premiumAdminPrintRouter.post('/worker', workerHandler(runAdminPremiumPrint));
premiumAdminPrintRouter.post('/worker-lost', workerHandler(markAdminPremiumPrintWorkerLost));

premiumAdminPrintRouter.get(
  '/:storyId/:revision/:runId/:part',
  adminPrintAuth,
  async (req, res) => {
    const input = download.safeParse(req.params);
    if (!input.success) {
      res.status(404).json({ error: 'PDF unavailable' });
      return;
    }
    const { runId, part, ...params } = input.data;
    try {
      const url = await signAdminPremiumPrint(params, runId, part);
      if (!url) {
        res.status(404).json({ error: 'PDF unavailable' });
        return;
      }
      res.json({ url });
    } catch (error) {
      printError(res, error);
    }
  },
);

const status: express.RequestHandler = async (req, res) => {
  const input = edition.safeParse(req.params);
  if (!input.success) {
    res.status(400).json({ error: 'Invalid edition' });
    return;
  }
  try {
    const data = await getAdminPremiumPrintStatus(input.data, req.method === 'POST');
    res.status(data.status === 'queued' && req.method === 'POST' ? 202 : 200).json(data);
  } catch (error) {
    printError(res, error);
  }
};

premiumAdminPrintRouter
  .route('/:storyId/:revision')
  .get(adminPrintAuth, status)
  .post(adminPrintAuth, status);
