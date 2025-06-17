/**
 * Test script for PDF generation
 * This script tests the PDF service with sample story content
 */

import { PDFService } from '../src/services/pdf.js';
import * as fs from 'fs/promises';
import * as path from 'path';

async function testPDFGeneration() {
  console.log('Starting PDF generation test...');

  const pdfService = new PDFService();

  // Sample story content with Mythoria classes
  const sampleStoryContent = `
    <h1 class="mythoria-story-title">The Magical Adventure</h1>

    <div class="mythoria-front-cover">
      <img src="https://via.placeholder.com/400x600/2c3e50/ffffff?text=Front+Cover" alt="Book Front Cover" class="mythoria-cover-image" />
    </div>

    <div class="mythoria-page-break"></div>

    <div class="mythoria-dedicatory">To all dreamers who believe in magic</div>

    <div class="mythoria-author-name">by Test Author</div>

    <div class="mythoria-message">
      <p class="mythoria-message-text">This story was imagined by <i class="mythoria-author-emphasis">Test Author</i>.</p>
      <p class="mythoria-message-text">Crafted with:</p>
      <img src="https://via.placeholder.com/200x100/3498db/ffffff?text=Mythoria+Logo" alt="Mythoria Logo" class="mythoria-logo" />
    </div>

    <div class="mythoria-page-break"></div>

    <div class="mythoria-table-of-contents">
      <h2 class="mythoria-toc-title">Table of Contents</h2>
      <ul class="mythoria-toc-list">
        <li class="mythoria-toc-item"><a href="#chapter-1" class="mythoria-toc-link">Chapter 1: The Beginning</a></li>
        <li class="mythoria-toc-item"><a href="#chapter-2" class="mythoria-toc-link">Chapter 2: The Adventure</a></li>
      </ul>
    </div>

    <div class="mythoria-page-break"></div>

    <div class="mythoria-chapter" id="chapter-1">
      <h2 class="mythoria-chapter-title">Chapter 1: The Beginning</h2>
      <div class="mythoria-chapter-image">
        <img src="https://via.placeholder.com/500x300/27ae60/ffffff?text=Chapter+1+Image" alt="Chapter 1 illustration" class="mythoria-chapter-img" />
      </div>
      <div class="mythoria-chapter-content">
        <p class="mythoria-chapter-paragraph">Once upon a time, in a land far, far away, there lived a young adventurer who dreamed of exploring the magical realms beyond the mountains.</p>
        <p class="mythoria-chapter-paragraph">This is the story of their incredible journey filled with wonder, friendship, and discovery.</p>
      </div>
    </div>

    <div class="mythoria-page-break"></div>

    <div class="mythoria-chapter" id="chapter-2">
      <h2 class="mythoria-chapter-title">Chapter 2: The Adventure</h2>
      <div class="mythoria-chapter-image">
        <img src="https://via.placeholder.com/500x300/e74c3c/ffffff?text=Chapter+2+Image" alt="Chapter 2 illustration" class="mythoria-chapter-img" />
      </div>
      <div class="mythoria-chapter-content">
        <p class="mythoria-chapter-paragraph">The adventure began at dawn, when our hero set out with nothing but courage and determination.</p>
        <p class="mythoria-chapter-paragraph">Along the way, they encountered magical creatures and learned valuable lessons about friendship and bravery.</p>
      </div>
    </div>

    <div class="mythoria-credits">
      <p class="mythoria-credits-text">This story was created with Mythoria AI - bringing imagination to life.</p>
    </div>
  `;

  try {
    // Test content validation
    const validation = PDFService.validateStoryContent(sampleStoryContent);
    console.log('Content validation:', validation);

    if (!validation.isValid) {
      console.warn('Content validation failed:', validation.missingElements);
    }

    // Generate PDF
    console.log('Generating PDF...');
    const pdfBuffer = await pdfService.generateStoryPDF(
      sampleStoryContent,
      'The Magical Adventure',
      'en'
    );

    // Save test PDF
    const outputPath = path.join(process.cwd(), 'test-output.pdf');
    await fs.writeFile(outputPath, pdfBuffer);

    console.log(`✅ PDF generated successfully!`);
    console.log(`📄 File size: ${(pdfBuffer.length / 1024).toFixed(2)} KB`);
    console.log(`📁 Saved to: ${outputPath}`);

    // Generate preview HTML for comparison
    const previewHTML = await pdfService.generatePreviewHTML(
      sampleStoryContent,
      'The Magical Adventure',
      'en'
    );

    const previewPath = path.join(process.cwd(), 'test-preview.html');
    await fs.writeFile(previewPath, previewHTML);
    console.log(`🌐 Preview HTML saved to: ${previewPath}`);

  } catch (error) {
    console.error('❌ PDF generation failed:');
    console.error(error);
    process.exit(1);
  }
}

// Run the test
testPDFGeneration()
  .then(() => {
    console.log('✅ Test completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });
