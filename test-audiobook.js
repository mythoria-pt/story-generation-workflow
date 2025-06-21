/**
 * Test script for the new audiobook generation workflow
 */

import { logger } from '../src/config/logger.js';

async function testAudiobookGeneration() {
  const baseUrl = 'http://localhost:3000';
  const testStoryId = 'test-story-id-123';

  logger.info('Testing audiobook generation workflow');

  try {
    // Test 1: Create audiobook request
    console.log('\n1. Testing POST /audio/create-audiobook');
    const response = await fetch(`${baseUrl}/audio/create-audiobook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        storyId: testStoryId,
        voice: 'nova'
      })
    });

    const result = await response.json();
    console.log('Response:', result);

    // Test 2: Test internal story endpoint
    console.log('\n2. Testing GET /internal/stories/:storyId');
    const storyResponse = await fetch(`${baseUrl}/internal/stories/${testStoryId}`);
    const storyResult = await storyResponse.json();
    console.log('Story Response:', storyResult);

    console.log('\n✅ Audio workflow tests completed');

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run tests
testAudiobookGeneration();
