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
// Removed logger mocks since we're using console.log directly in the context manager

// Mock Google Cloud services for tests
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(() => ({
    bucket: jest.fn(() => ({
      file: jest.fn(() => ({
        save: jest.fn(),
        getSignedUrl: jest.fn(),
        delete: jest.fn(),
      })),    })),
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
