import { MessageService } from './src/services/message.js';

async function testTranslations() {
  try {
    console.log('Testing English translations:');
    console.log('Table of Contents:', await MessageService.getTableOfContentsTitle('en-US'));
    console.log('Story Imagined By:', await MessageService.getStoryImaginedByMessage('en-US', 'John Doe'));
    console.log('Crafted With:', await MessageService.getCraftedWithMessage('en-US'));
    console.log('By Author:', await MessageService.getByAuthorMessage('en-US', 'John Doe'));

    console.log('\nTesting Portuguese translations:');
    console.log('Table of Contents:', await MessageService.getTableOfContentsTitle('pt-PT'));
    console.log('Story Imagined By:', await MessageService.getStoryImaginedByMessage('pt-PT', 'João Silva'));
    console.log('Crafted With:', await MessageService.getCraftedWithMessage('pt-PT'));
    console.log('By Author:', await MessageService.getByAuthorMessage('pt-PT', 'João Silva'));
  } catch (error) {
    console.error('Error testing translations:', error);
  }
}

testTranslations();
