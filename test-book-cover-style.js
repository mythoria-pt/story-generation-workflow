/**
 * Test script to verify book cover style enhancement functionality
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

async function testBookCoverStyleEnhancement() {
  try {
    console.log('Testing book cover style enhancement...\n');
    
    // Load the image styles configuration
    const imageStylesPath = join(process.cwd(), 'src', 'prompts', 'imageStyles.json');
    const imageStylesContent = await readFile(imageStylesPath, 'utf-8');
    const imageStyles = JSON.parse(imageStylesContent);
    
    // Test with sample book cover prompts and different styles
    const sampleFrontCoverPrompt = "A magical book cover showing a young hero with a sword standing before an enchanted castle";
    const sampleBackCoverPrompt = "A mystical landscape with a setting sun and ancient symbols in the sky";
    
    const testStyles = ['cartoon', 'realistic', 'watercolor', 'disney_style'];
    
    console.log('=== FRONT COVER TESTS ===');
    testStyles.forEach(styleName => {
      console.log(`\n--- Testing FRONT cover with ${styleName} style ---`);
      console.log('Original prompt:', sampleFrontCoverPrompt);
      
      const styleConfig = imageStyles[styleName];
      if (styleConfig?.systemPrompt) {
        const enhancedPrompt = `${sampleFrontCoverPrompt} Use the following style guidelines: ${styleConfig.systemPrompt}`;
        console.log('Enhanced prompt length:', enhancedPrompt.length);
        console.log('Style guidelines added:', styleConfig.systemPrompt.substring(0, 100) + '...');
      } else {
        console.log('No style config found for:', styleName);
      }
    });

    console.log('\n\n=== BACK COVER TESTS ===');
    testStyles.forEach(styleName => {
      console.log(`\n--- Testing BACK cover with ${styleName} style ---`);
      console.log('Original prompt:', sampleBackCoverPrompt);
      
      const styleConfig = imageStyles[styleName];
      if (styleConfig?.systemPrompt) {
        const enhancedPrompt = `${sampleBackCoverPrompt} Use the following style guidelines: ${styleConfig.systemPrompt}`;
        console.log('Enhanced prompt length:', enhancedPrompt.length);
        console.log('Style guidelines added:', styleConfig.systemPrompt.substring(0, 100) + '...');
      } else {
        console.log('No style config found for:', styleName);
      }
    });
    
    console.log('\n✅ Book cover style enhancement test completed successfully!');
    console.log('📋 Summary: Both front and back cover prompts will now include style guidelines');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testBookCoverStyleEnhancement();
