import { Router } from 'express';
import { getAIGateway } from '@/ai/gateway-singleton.js';
import { logger } from '@/config/logger.js';

export const debugImageRouter = Router();

// Sample prompt for quick manual testing
const SAMPLE_PROMPT = `A whimsical children book cover illustration of a cheerful young explorer boy wearing a red scarf, standing on a grassy hill at sunrise, bright saturated colors, soft painterly style, clean background, storybook art.`;

interface DebugResult {
  model: string;
  promptPreview: string;
  usedVertex: boolean;
  forceRest: boolean;
  disableMapping: boolean;
  projectId?: string;
  location?: string;
  timingMs?: number;
  error?: string;
  imageSize?: number;
}

// GET returns only diagnostic info (no image) unless ?image=true
debugImageRouter.get('/image', async (req, res) => {
  const gateway = getAIGateway();
  const imageService: any = gateway.getImageService();
  const forceRest = process.env.GOOGLE_GENAI_FORCE_REST === 'true';
  const disableMapping = process.env.GOOGLE_GENAI_DISABLE_IMAGEN_MAPPING === 'true';
  const result: DebugResult = {
    model: imageService['model'],
    promptPreview: SAMPLE_PROMPT.slice(0, 120),
    usedVertex: Boolean(imageService['projectId']),
    forceRest,
    disableMapping,
    projectId: imageService['projectId'],
    location: imageService['location'],
  };

  if (req.query.image === 'true') {
    const started = Date.now();
    try {
      const buf = await imageService.generate(SAMPLE_PROMPT);
      result.timingMs = Date.now() - started;
      result.imageSize = buf.length;
      const b64 = buf.toString('base64');
      res.json({ ...result, imageBase64: b64 });
      return;
    } catch (e) {
      result.timingMs = Date.now() - started;
      result.error = e instanceof Error ? e.message : String(e);
      logger.error('Debug image generation failed', result);
      res.status(500).json(result);
      return;
    }
  } else {
    res.json(result);
  }
});

// POST allows custom prompt
debugImageRouter.post('/image', async (req, res) => {
  const gateway = getAIGateway();
  const imageService: any = gateway.getImageService();
  const prompt: string = (req.body?.prompt || SAMPLE_PROMPT).toString();
  const started = Date.now();
  const forceRest = process.env.GOOGLE_GENAI_FORCE_REST === 'true';
  const disableMapping = process.env.GOOGLE_GENAI_DISABLE_IMAGEN_MAPPING === 'true';

  const diag: DebugResult = {
    model: imageService['model'],
    promptPreview: prompt.slice(0, 120),
    usedVertex: Boolean(imageService['projectId']),
    forceRest,
    disableMapping,
    projectId: imageService['projectId'],
    location: imageService['location'],
  };

  try {
    const buf = await imageService.generate(prompt);
    diag.timingMs = Date.now() - started;
    diag.imageSize = buf.length;
    res.json({ ...diag, imageBase64: buf.toString('base64') });
  } catch (e) {
    diag.timingMs = Date.now() - started;
    diag.error = e instanceof Error ? e.message : String(e);
    logger.error('Debug image generation failed', diag);
    res.status(500).json(diag);
  }
});
