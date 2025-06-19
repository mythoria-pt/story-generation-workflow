#!/usr/bin/env node
/**
 * Simple test script to validate TTS audiobook validation behavior
 */

import { TTSService } from './dist/services/tts.js';

// Create a mock story without audioBook enabled
const mockStoryService = {
  getStory: async (storyId) => ({
    storyId,
    title: 'Test Story',
    features: {
      // audioBook is not enabled
      someOtherFeature: true
    }
  })
};

// Create a mock runs service  
const mockRunsService = {
  getRun: async (runId) => ({
    storyId: 'test-story-id',
    status: 'running'
  }),
  getRunSteps: async () => [],
  storeStepResult: async () => {}
};

async function testTTSBehavior() {
  console.log('Testing TTS service behavior when audioBook is not enabled...\n');
  
  const ttsService = new TTSService();
  
  // Inject mocks
  ttsService.storyService = mockStoryService;
  ttsService.runsService = mockRunsService;
  
  try {
    // Test generateNarration - should return empty result, not throw error
    console.log('1. Testing generateNarration...');
    const result = await ttsService.generateNarration('test-run-id');
    
    console.log('✓ generateNarration returned successfully:');
    console.log('  - audioUrls:', JSON.stringify(result.audioUrls));
    console.log('  - chaptersProcessed:', result.metadata.chaptersProcessed);
    console.log('  - totalDuration:', result.totalDuration);
    
    // Test generateChapterNarration - should return empty result, not throw error
    console.log('\n2. Testing generateChapterNarration...');
    const chapterResult = await ttsService.generateChapterNarration('test-run-id', 1);
    
    console.log('✓ generateChapterNarration returned successfully:');
    console.log('  - chapterNumber:', chapterResult.chapterNumber);
    console.log('  - audioUrl:', chapterResult.audioUrl);
    console.log('  - duration:', chapterResult.duration);
    
    console.log('\n✓ All tests passed! TTS service handles disabled audioBook correctly.');
    
  } catch (error) {
    console.error('✗ Test failed with error:', error);
    process.exit(1);  
  }
}

testTTSBehavior().catch(console.error);
