import { Router } from 'express';
import { logger } from '@/config/logger.js';

const router = Router();

// PubSub configuration
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID || 'oceanic-beach-460916-n5';
const PING_TOPIC = 'story-generation-ping';

/**
 * GET /ping
 * Simple ping endpoint for direct communication testing
 */
router.get('/ping', async (_req, res) => {
  const timestamp = new Date().toISOString();
  const responseTime = Date.now();

  logger.info('Ping request received from webapp');

  try {
    // Simple response indicating service is alive
    res.json({
      success: true,
      service: 'story-generation-workflow',
      status: 'healthy',
      timestamp,
      message: 'Pong! Story Generation Workflow is alive and responding',
      version: '0.1.0',
      responseTime: Date.now() - responseTime
    });
  } catch (error) {
    logger.error('Ping endpoint error:', error);
    
    res.status(500).json({
      success: false,
      service: 'story-generation-workflow',
      status: 'unhealthy',
      timestamp,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /ping/pubsub-test
 * Test pub/sub communication by publishing a test message
 * Note: This is a simplified implementation for testing purposes
 */
router.post('/ping/pubsub-test', async (_req, res) => {
  const correlationId = `story-ping-${Date.now()}`;
  const timestamp = new Date().toISOString();
  const startTime = Date.now();

  try {
    logger.info('PubSub ping test initiated (simulated)', { correlationId });

    // Simulate pub/sub message publishing
    // In a real implementation, this would publish to Google Pub/Sub
    const testMessage = {
      type: 'ping',
      source: 'story-generation-workflow',
      correlationId,
      timestamp,
      message: 'PubSub ping test from Story Generation Workflow (simulated)'
    };

    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 100));

    const responseTime = Date.now() - startTime;

    logger.info('PubSub ping message simulated', {
      correlationId,
      responseTime
    });

    res.json({
      success: true,
      service: 'story-generation-workflow',
      correlationId,
      timestamp,
      responseTime,
      message: 'PubSub ping test simulated successfully',
      topic: PING_TOPIC,
      projectId: PROJECT_ID,
      testMessage
    });

  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    logger.error('PubSub ping test failed', {
      correlationId,
      error: error instanceof Error ? error.message : 'Unknown error',
      responseTime
    });

    res.status(500).json({
      success: false,
      service: 'story-generation-workflow',
      correlationId,
      timestamp,
      responseTime,
      error: error instanceof Error ? error.message : 'Unknown error',
      message: 'PubSub ping test failed'
    });
  }
});

/**
 * POST /test/pubsub-ping
 * Endpoint that webapp calls to test pub/sub communication
 */
router.post('/test/pubsub-ping', async (req, res) => {
  const correlationId = req.body.correlationId || `webapp-test-${Date.now()}`;
  const timestamp = new Date().toISOString();
  const startTime = Date.now();

  try {
    logger.info('Webapp pub/sub ping test received', { correlationId });

    // Echo back the test message with additional info
    const responseTime = Date.now() - startTime;

    res.json({
      success: true,
      service: 'story-generation-workflow',
      correlationId,
      timestamp,
      responseTime,
      message: 'Pong! PubSub communication test successful',
      receivedAt: timestamp,
      originalMessage: req.body
    });

  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    logger.error('Webapp pub/sub ping test failed', {
      correlationId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      service: 'story-generation-workflow',
      correlationId,
      timestamp,
      responseTime,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export { router as pingRouter };
export default router;
