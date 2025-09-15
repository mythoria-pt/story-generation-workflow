import express from 'express';
import helmet from 'helmet';
import { Server } from 'http';
import { getEnvironment } from '@/config/environment.js';
import { logger } from '@/config/logger.js';
import { closeDatabaseConnection } from '@/db/connection.js';
import { HealthService } from '@/shared/health.js';

const app = express();
const env = getEnvironment();
const healthService = new HealthService();

// Security middleware
app.use(helmet());

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', async (_req, res) => {
  try {
    const healthStatus = await healthService.checkHealth(env.NODE_ENV);
    
    // Set appropriate HTTP status code based on health
    const statusCode = healthStatus.status === 'healthy' ? 200 : 503;
    
    res.status(statusCode).json(healthStatus);
  } catch (error) {
    logger.error('Health check endpoint error:', error);
    
    res.status(503).json({
      status: 'unhealthy',
      service: 'story-generation-workflow',
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
      version: '0.1.0',
      checks: {
        database: {
          status: 'unhealthy',
          message: 'Health check failed to execute'
        },
        internet: {
          status: 'unhealthy',
          message: 'Health check failed to execute',
          url: 'https://www.google.com'
        }
      }
    });
  }
});

// Basic route
app.get('/', (_req, res) => {
  res.json({
    message: 'Story Generation Workflow Service',
    version: '0.1.0',
    environment: env.NODE_ENV
  });
});

// Import and mount API routes
import { aiRouter } from './routes/ai.js';
import { internalRouter } from './routes/internal.js';
import { storyEditRouter } from './routes/story-edit.js';
import { audioRouter } from './routes/audio.js';
import { printRouter } from './routes/print.js';
import { pingRouter } from './routes/ping.js';
import { asyncJobRouter } from './routes/async-jobs.js';
import { getAIGateway } from '@/ai/gateway-singleton.js';
import { getStorageService } from '@/services/storage-singleton.js';
import { CMYKConversionService } from '@/services/cmyk-conversion.js';
import { debugImageRouter } from '@/routes/debug-image.js';
import apiKeyAuth from './middleware/apiKeyAuth.js';
// Protect external-facing APIs with x-api-key
{
  const hasKey = Boolean((process.env.STORY_GENERATION_WORKFLOW_API_KEY || '').trim());
  logger.info(`API key configured for external routes: ${hasKey}`);
}
// Unauthenticated debug endpoint (non-production recommendation: secure or remove)
app.use('/debug', debugImageRouter);
app.use('/ai', apiKeyAuth, aiRouter);
app.use('/audio', apiKeyAuth, audioRouter);
app.use('/internal', internalRouter); // keep internal open or handle separately
app.use('/internal/print', printRouter);
app.use('/api/story-edit', apiKeyAuth, storyEditRouter);
app.use('/api/jobs', apiKeyAuth, asyncJobRouter);
app.use('/', apiKeyAuth, pingRouter);  // ping/test endpoints protected as well

// Error handling middleware
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path
  });
});

// Graceful server startup with port conflict handling
async function startServer() {
  const port = env.PORT;    const tryStartServer = (portToTry: number): Promise<Server> => {
    return new Promise<Server>((resolve, reject) => {
      const server = app.listen(portToTry, () => {
        logger.info(`🚀 Story Generation Workflow Service started`);
        logger.info(`📍 Environment: ${env.NODE_ENV}`);
        logger.info(`🔌 Port: ${portToTry}`);
        logger.info(`🏢 Project: ${env.GOOGLE_CLOUD_PROJECT_ID}`);
        // Optional warm-up: initialize lazy singletons to fail-fast and reduce first-request latency
        try {
          getAIGateway();
          getStorageService();
          // Best-effort Ghostscript validation so container logs confirm CMYK readiness
          (async () => {
            try {
              const cmyk = new CMYKConversionService();
              const ok = await cmyk.validateGhostscript();
              if (!ok) {
                logger.warn('Ghostscript not available; CMYK conversion will be skipped');
              }
            } catch (e) {
              logger.warn('Ghostscript validation encountered an error', { error: e instanceof Error ? e.message : String(e) });
            }
          })();
          logger.info('Warm-up: core singletons initialized');
        } catch (warmErr) {
          logger.error('Warm-up failed (continuing):', warmErr);
        }
        resolve(server);
      });      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(err);
        } else {
          logger.error('Server failed to start:', err);
          process.exit(1);
        }
      });
    });
  };

  let currentPort = port;  let server: Server | undefined;
  
  // Try to start server, handling port conflicts
  while (!server && currentPort < port + 10) {
    try {
      server = await tryStartServer(currentPort);
      if (currentPort !== port) {
        logger.info(`Port ${port} was in use, successfully started on port ${currentPort}`);
      }
      break;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EADDRINUSE' && !process.env.PORT) {
        // Only auto-retry with different port if PORT wasn't explicitly set
        logger.warn(`Port ${currentPort} is already in use, trying port ${currentPort + 1}...`);
        currentPort++;
      } else {
        logger.error('Server failed to start:', err);
        process.exit(1);
      }
    }
  }

  if (!server) {
    logger.error(`Failed to find available port after trying ports ${port} to ${currentPort - 1}`);
    process.exit(1);
  }

  setupGracefulShutdown(server);
}

function setupGracefulShutdown(server: Server) {
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down gracefully');
    server.close(async () => {
      await closeDatabaseConnection();
      process.exit(0);
    });
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down gracefully');
    server.close(async () => {
      await closeDatabaseConnection();
      process.exit(0);
    });
  });
}

// Start the server
startServer();

export default app;
