#!/usr/bin/env node

/**
 * Test script for triggering the story generation workflow
 */

const BASE_URL = 'http://localhost:8080';
const STORY_ID = '6da9576a-85b6-44e2-824c-1fbfb20ba970';
const RUN_ID = '2eaa716a-2b3a-4388-8f0b-9b3880ffa2c6';

async function testWorkflowTrigger() {
  console.log('🧪 Testing Workflow Trigger');
  console.log('================================');
  
  try {
    // Start the workflow
    console.log('🚀 Starting workflow...');
    const startResponse = await fetch(`${BASE_URL}/api/workflow/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        storyId: STORY_ID,
        runId: RUN_ID,
        prompt: 'A fantasy adventure about a young wizard discovering their powers'
      })
    });

    const startResult = await startResponse.json();
    console.log('✅ Workflow start response:', JSON.stringify(startResult, null, 2));

    if (startResult.success && startResult.executionId) {
      console.log('📊 Checking workflow status...');
      
      // Wait a bit then check status
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const statusResponse = await fetch(`${BASE_URL}/api/workflow/status/${startResult.executionId}`);
      const statusResult = await statusResponse.json();
      
      console.log('📋 Workflow status response:', JSON.stringify(statusResult, null, 2));
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
testWorkflowTrigger();
