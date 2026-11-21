import { Router } from 'express';
import {
  interviewRequest,
  proposalRequest,
  requireBiographer,
  whispererRequest,
  whispererCondenseRequest,
} from '@/services/biographer/contract.js';
import {
  condenseWhispererSeed,
  interview,
  propose,
  whisper,
} from '@/services/biographer/interviewer.js';
import { logger } from '@/config/logger.js';

export const biographerRouter = Router();
for (const operation of ['interview', 'proposal'] as const) {
  biographerRouter.post(`/${operation}`, async (req, res) => {
    if (process.env.BIOGRAPHER_ENABLED !== 'true') {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const parsed = (operation === 'interview' ? interviewRequest : proposalRequest).safeParse(
      req.body,
    );
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid biographer input' });
      return;
    }
    try {
      requireBiographer();
      const result =
        operation === 'interview'
          ? await interview(interviewRequest.parse(parsed.data))
          : await propose(proposalRequest.parse(parsed.data));
      res.json(result);
    } catch (error) {
      logger.warn('Biographer operation failed', {
        operation,
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      res.status(503).json({ error: 'Biographer temporarily unavailable' });
    }
  });
}

biographerRouter.post('/transcribe', async (req, res) => {
  if (process.env.BIOGRAPHER_ENABLED !== 'true') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const { transcriptionRequest, transcribeRecording } =
    await import('@/services/biographer/transcribe.js');
  const input = transcriptionRequest.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: 'Invalid recording' });
    return;
  }
  try {
    res.json(await transcribeRecording(input.data));
  } catch {
    res.status(503).json({ error: 'Recording transcription unavailable; saved audio is retained' });
  }
});

for (const route of ['/whisperer', '/whisperer/condense'] as const) {
  biographerRouter.post(route, async (req, res) => {
    if (process.env.BIOGRAPHER_ENABLED !== 'true') {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const schema = route === '/whisperer' ? whispererRequest : whispererCondenseRequest;
    const input = schema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Invalid Story Whisperer input' });
      return;
    }
    try {
      const result =
        route === '/whisperer'
          ? await whisper(whispererRequest.parse(input.data))
          : await condenseWhispererSeed(whispererCondenseRequest.parse(input.data));
      res.json(result);
    } catch (error) {
      logger.warn('Story Whisperer request failed', {
        route,
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      res.status(503).json({ error: 'Story Whisperer temporarily unavailable' });
    }
  });
}
