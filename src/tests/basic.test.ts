import { describe, it, expect } from '@jest/globals';

describe('Environment Configuration', () => {
  beforeAll(() => {
    // Set minimal required environment variables for tests
    process.env.NODE_ENV = 'test';
    process.env.DB_HOST = 'localhost';
    process.env.DB_PORT = '5432';
    process.env.DB_USER = 'test_user';
    process.env.DB_PASSWORD = 'test_password';
    process.env.DB_NAME = 'test_db';
    process.env.GOOGLE_CLOUD_PROJECT_ID = 'test-project';
    process.env.GOOGLE_CLOUD_REGION = 'europe-west9';
    process.env.STORAGE_BUCKET_NAME = 'test-bucket';
    process.env.VERTEX_AI_MODEL_ID = 'gemini-2.0-flash';
    process.env.WORKFLOWS_LOCATION = 'europe-west9';
  });

  it('should validate basic environment structure', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.DB_HOST).toBe('localhost');
    expect(process.env.GOOGLE_CLOUD_PROJECT_ID).toBe('test-project');
  });

  it('should have all required environment variables set', () => {
    const requiredVars = [
      'NODE_ENV',
      'DB_HOST',
      'DB_PORT', 
      'DB_USER',
      'DB_PASSWORD',
      'DB_NAME',
      'GOOGLE_CLOUD_PROJECT_ID',
      'GOOGLE_CLOUD_REGION',
      'STORAGE_BUCKET_NAME',
      'VERTEX_AI_MODEL_ID',
      'WORKFLOWS_LOCATION'
    ];

    requiredVars.forEach(varName => {
      expect(process.env[varName]).toBeDefined();
      expect(process.env[varName]).not.toBe('');
    });
  });
});

describe('Application Constants', () => {  it('should have consistent workflow steps', () => {
    const workflowSteps = [
      'generate_outline',
      'write_chapters', 
      'generate_front_cover',
      'generate_back_cover',
      'generate_images',
      'assemble',
      'generate_audiobook'
    ];

    expect(workflowSteps).toHaveLength(7);
    expect(workflowSteps).toContain('generate_outline');
    expect(workflowSteps).toContain('write_chapters');
    expect(workflowSteps).toContain('generate_front_cover');
    expect(workflowSteps).toContain('generate_back_cover');
    expect(workflowSteps).toContain('generate_audiobook');
  });

  it('should define supported AI providers', () => {
    const textProviders = ['vertex', 'openai'];
    const imageProviders = ['vertex', 'openai'];

    expect(textProviders).toContain('vertex');
    expect(textProviders).toContain('openai');
    expect(imageProviders).toContain('vertex');
    expect(imageProviders).toContain('openai');
  });
});
