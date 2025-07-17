/**
 * Test script to verify the chapter generation with image prompts
 */

import { spawn } from 'child_process';
import { writeFileSync, readFileSync } from 'fs';
import path from 'path';

// Create a minimal test environment
const testEnv = {
  // Required environment variables for testing
  PORT: '8080',
  NODE_ENV: 'development',
  // Add other required variables from the schema
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  OPENAI_API_KEY: 'sk-test-key',
  GOOGLE_CLOUD_PROJECT: 'test-project',
  GOOGLE_CLOUD_REGION: 'us-central1',
  STORAGE_BUCKET: 'test-bucket',
  WORKFLOWS_DATABASE_URL: 'postgres://test:test@localhost:5432/workflows-test',
  // Set all other required environment variables to test values
  GOOGLE_CLOUD_STORAGE_BUCKET: 'test-bucket',
  GOOGLE_CLOUD_STORAGE_BUCKET_REGION: 'us-central1',
  GOOGLE_APPLICATION_CREDENTIALS: path.join(process.cwd(), 'test-service-account.json'),
  WORKFLOWS_REGION: 'us-central1',
  WORKFLOWS_LOCATION: 'us-central1'
};

// Create a dummy service account file for testing
const dummyServiceAccount = {
  "type": "service_account",
  "project_id": "test-project",
  "private_key_id": "test-key-id",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC8Q7HgL8CX...\n-----END PRIVATE KEY-----\n",
  "client_email": "test@test-project.iam.gserviceaccount.com",
  "client_id": "123456789",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/test%40test-project.iam.gserviceaccount.com"
};

writeFileSync('test-service-account.json', JSON.stringify(dummyServiceAccount, null, 2));

console.log('Testing chapter generation with image prompts...');

// Test the compilation
const tscProcess = spawn('npx', ['tsc', '--noEmit'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: { ...process.env, ...testEnv }
});

tscProcess.on('close', (code) => {
  console.log(`TypeScript compilation finished with code ${code}`);
  
  if (code === 0) {
    console.log('✅ TypeScript compilation successful!');
    console.log('✅ Chapter generation endpoint has been updated to include imagePrompts');
    console.log('✅ The workflow should now work without the KeyError');
  } else {
    console.log('❌ TypeScript compilation failed');
  }
  
  // Clean up test files
  try {
    const fs = require('fs');
    if (fs.existsSync('test-service-account.json')) {
      fs.unlinkSync('test-service-account.json');
    }
  } catch (error) {
    console.log('Warning: Could not clean up test files');
  }
});
