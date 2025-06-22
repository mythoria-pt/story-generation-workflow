/**
 * PDF Routes
 * Handles PDF generation endpoints
 */

import express from 'express';
import { StoryPDFService } from '../services/story-pdf.js';
import { logger } from '@/config/logger.js';

export const pdfRouter = express.Router();
const storyPDFService = new StoryPDFService();

/**
 * POST /pdf/create
 * Generate PDF for a story
 * 
 * Body: { storyId: string }
 * Returns: 200 OK with PDF generation result
 */
pdfRouter.post('/create', async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const { storyId } = req.body;

    // Validate input
    if (!storyId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'storyId is required'
      });
      return;
    }

    if (typeof storyId !== 'string') {
      res.status(400).json({
        error: 'Bad Request',
        message: 'storyId must be a string'
      });
      return;
    }

    logger.info('PDF creation request received', { storyId });

    // Generate PDF
    const result = await storyPDFService.generateStoryPDF(storyId);

    logger.info('PDF creation completed successfully', {
      storyId,
      pdfUri: result.pdfUri,
      version: result.version
    });

    // Return 200 OK
    res.status(200).json({
      message: 'PDF created successfully',
      storyId,
      pdfUri: result.pdfUri,
      version: result.version,
      metadata: result.metadata
    });

  } catch (error) {
    logger.error('PDF creation failed', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.body?.storyId
    });

    // Handle specific error types
    if (error instanceof Error) {
      if (error.message.includes('Story not found')) {
        res.status(404).json({
          error: 'Not Found',
          message: `Story not found: ${req.body?.storyId}`
        });
        return;
      }

      if (error.message.includes('Story HTML not found')) {
        res.status(404).json({
          error: 'Not Found',
          message: 'Story HTML content not found. Please ensure the story has been assembled first.'
        });
        return;
      }

      if (error.message.includes('Failed to load')) {
        res.status(500).json({
          error: 'Internal Server Error',
          message: 'Failed to load required resources for PDF generation'
        });
        return;
      }
    }

    // Generic error response
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to generate PDF'
    });
  }
});
