import winston from 'winston';
import { getEnvironment } from './environment.js';

const env = getEnvironment();

const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'story-generation-workflow' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )    })
  ]
});

// In production, rely on Cloud Run's console log capture
// No file transports needed since Cloud Run captures console output

export { logger };
