// Jest setup file for tests
import { config } from 'dotenv';

// Load test environment variables (local overrides optional files)
config({ path: '.env.test', quiet: true });
config({ path: '.env', quiet: true });
config({ path: '.env.local', quiet: true });

// Set test environment if not already set
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

/** Zod + workflows DB require these when tests import app modules; CI may omit .env.local. */
function applyTestEnvDefaults() {
  if (process.env.NODE_ENV !== 'test') return;
  const defaults: Record<string, string> = {
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_USER: 'postgres',
    DB_PASSWORD: 'postgres',
    DB_NAME: 'test_db',
    WORKFLOWS_DB: 'workflows_db',
    GOOGLE_CLOUD_PROJECT_ID: 'test-project',
    GOOGLE_CLOUD_REGION: 'us-central1',
    STORAGE_BUCKET_NAME: 'test-bucket',
    STORY_GENERATION_WORKFLOW_API_KEY: 'test-api-key',
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}
applyTestEnvDefaults();

// Mock logger to reduce noise in tests
// Removed logger mocks since we're using console.log directly in the context manager
jest.mock('@/config/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock Google Cloud services for tests
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(() => ({
    bucket: jest.fn(() => ({
      file: jest.fn(() => ({
        save: jest.fn(),
        getSignedUrl: jest.fn(),
        delete: jest.fn(),
      })),
    })),
  })),
}));

// Note: Removed @google-cloud/vertexai mock since we're no longer using Vertex AI
// Now using Google GenAI instead

jest.mock('@google-cloud/workflows', () => ({
  WorkflowsClient: jest.fn(() => ({
    createExecution: jest.fn(),
    getExecution: jest.fn(),
  })),
}));

// Global test timeout
jest.setTimeout(30000);
