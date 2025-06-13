// Jest setup file for tests
import { config } from 'dotenv';

// Load test environment variables
config({ path: '.env.test' });
config({ path: '.env' });

// Set test environment if not already set
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

// Mock logger to reduce noise in tests
jest.mock('@/config/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
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

jest.mock('@google-cloud/vertexai', () => ({
  VertexAI: jest.fn(() => ({
    getGenerativeModel: jest.fn(),
  })),
}));

jest.mock('@google-cloud/workflows', () => ({
  WorkflowsClient: jest.fn(() => ({
    createExecution: jest.fn(),
    getExecution: jest.fn(),
  })),
}));

// Global test timeout
jest.setTimeout(30000);
