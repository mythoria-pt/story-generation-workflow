/**
 * Test script for message service
 */
import { MessageService } from '../services/message.js';

async function testMessageService() {
  try {
    console.log('Testing MessageService...');
    
    // Test English messages
    const enMessages = await MessageService.loadMessages('en-US');
    console.log('English messages loaded:', enMessages.Story.credits);
    
    // Test Portuguese messages
    const ptMessages = await MessageService.loadMessages('pt-PT');
    console.log('Portuguese messages loaded:', ptMessages.Story.credits);
    
    // Test credits with author substitution
    const enCredits = await MessageService.getCreditsMessage('en-US', 'John Doe');
    console.log('English credits:', enCredits);
    
    const ptCredits = await MessageService.getCreditsMessage('pt-PT', 'João Silva');
    console.log('Portuguese credits:', ptCredits);
    
    // Test locale normalization
    const normalizedCredits = await MessageService.getCreditsMessage('pt', 'Maria Santos');
    console.log('Normalized Portuguese credits:', normalizedCredits);
    
    console.log('All tests passed!');
  } catch (error) {
    console.error('Test failed:', error);
  }
}

testMessageService();
