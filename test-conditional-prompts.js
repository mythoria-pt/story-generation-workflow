/**
 * Simple test to verify conditional prompt optimization
 */

import { PromptService } from './dist/services/prompt.js';

async function testConditionalPrompts() {
    console.log('Testing conditional prompt optimization...\n');

    // Test 1: With custom instructions
    console.log('=== Test 1: With custom instructions ===');
    const templateWithInstructions = `
<system_prompt>
This is a test prompt.

{{#customInstructions}}<custom_instructions>
The following custom instructions should be incorporated:
{{customInstructions}}
</custom_instructions>{{/customInstructions}}
</system_prompt>
`;

    const variables1 = {
        customInstructions: 'Make it colorful and vibrant'
    };

    const result1 = PromptService.processPrompt(templateWithInstructions, variables1);
    console.log('Input template:');
    console.log(templateWithInstructions);
    console.log('Variables:', variables1);
    console.log('Result:');
    console.log(result1);
    console.log('\n');

    // Test 2: Without custom instructions (empty string)
    console.log('=== Test 2: Without custom instructions (empty string) ===');
    const variables2 = {
        customInstructions: ''
    };

    const result2 = PromptService.processPrompt(templateWithInstructions, variables2);
    console.log('Variables:', variables2);
    console.log('Result:');
    console.log(result2);
    console.log('\n');

    // Test 3: Without custom instructions (null)
    console.log('=== Test 3: Without custom instructions (null) ===');
    const variables3 = {
        customInstructions: null
    };

    const result3 = PromptService.processPrompt(templateWithInstructions, variables3);
    console.log('Variables:', variables3);
    console.log('Result:');
    console.log(result3);
    console.log('\n');

    // Test 4: Without custom instructions (undefined)
    console.log('=== Test 4: Without custom instructions (undefined) ===');
    const variables4 = {
        customInstructions: undefined
    };

    const result4 = PromptService.processPrompt(templateWithInstructions, variables4);
    console.log('Variables:', variables4);
    console.log('Result:');
    console.log(result4);
    console.log('\n');

    // Test 5: Test actual image prompt template
    console.log('=== Test 5: Test actual back_cover.json template ===');
    try {
        const backCoverTemplate = await PromptService.loadImagePrompt('back_cover');
        
        const variablesWithInstructions = {
            bookTitle: 'My Amazing Book',
            promptText: 'A mysterious forest with magical creatures',
            customInstructions: 'Use bright colors and make it child-friendly'
        };
        
        const variablesWithoutInstructions = {
            bookTitle: 'My Amazing Book',
            promptText: 'A mysterious forest with magical creatures',
            customInstructions: ''
        };
        
        const resultWith = PromptService.buildPrompt(backCoverTemplate, variablesWithInstructions);
        const resultWithout = PromptService.buildPrompt(backCoverTemplate, variablesWithoutInstructions);
        
        console.log('Back cover with instructions:');
        console.log(resultWith);
        console.log('\n---\n');
        
        console.log('Back cover without instructions:');
        console.log(resultWithout);
        
        // Check if the optimization worked
        if (resultWithout.includes('custom_instructions')) {
            console.log('\n❌ FAILED: Custom instructions section still present when empty');
        } else {
            console.log('\n✅ SUCCESS: Custom instructions section removed when empty');
        }
        
    } catch (error) {
        console.error('Error testing actual template:', error.message);
    }
}

testConditionalPrompts().catch(console.error);
