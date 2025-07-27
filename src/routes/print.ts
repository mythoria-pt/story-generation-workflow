import express from 'express';
import { PrintGenerationHandler } from '@/workflows/handlers.js';
import { logger } from '@/config/logger.js';

export const printRouter = express.Router();

// Print generation endpoint
printRouter.post('/generate', async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const { storyId, workflowId } = req.body;

    if (!storyId || !workflowId) {
      res.status(400).json({
        error: 'Missing required fields',
        required: ['storyId', 'workflowId']
      });
      return;
    }

    logger.info('Print generation request received', { storyId, workflowId });

    const handler = new PrintGenerationHandler();
    const result = await handler.execute({ storyId, workflowId });

    res.json(result);
  } catch (error) {
    logger.error('Print generation failed:', error);
    res.status(500).json({
      error: 'Print generation failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});
