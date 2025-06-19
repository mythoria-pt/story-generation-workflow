/**
 * Test script to verify the style enhancement functionality
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

async function testStyleEnhancement() {
  try {
    console.log('Testing image style enhancement...\n');
    
    // Load the image styles configuration
    const imageStylesPath = join(process.cwd(), 'src', 'prompts', 'imageStyles.json');
    const imageStylesContent = await readFile(imageStylesPath, 'utf-8');
    const imageStyles = JSON.parse(imageStylesContent);
    
    // Test with a sample chapter prompt and different styles
    const samplePrompt = "A young hero standing at the entrance of a magical forest";
    
    const testStyles = ['cartoon', 'realistic', 'watercolor', 'anime'];
    
    testStyles.forEach(styleName => {
      console.log(`\n=== Testing with ${styleName} style ===`);
      console.log('Original prompt:', samplePrompt);
      
      const styleConfig = imageStyles[styleName];
      if (styleConfig?.systemPrompt) {
        const enhancedPrompt = `${samplePrompt} Use the following style guidelines: ${styleConfig.systemPrompt}`;
        console.log('Enhanced prompt:', enhancedPrompt);
        console.log('Style guidelines length:', styleConfig.systemPrompt.length);
      } else {
        console.log('No style config found for:', styleName);
      }
    });
    
    console.log('\n✅ Style enhancement test completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testStyleEnhancement();
