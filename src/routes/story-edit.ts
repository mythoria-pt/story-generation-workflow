/**
 * Story Edit API Routes
 * Endpoints for editing existing published stories using AI
 */

import { Router } from 'express';
import { z } from 'zod';
import { logger } from '@/config/logger.js';
import { StoryService } from '@/services/story.js';
import { StorageService } from '@/services/storage.js';
import { PromptService } from '@/services/prompt.js';
import { AIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking-v2.js';
import { formatTargetAudience, getLanguageName } from '@/shared/utils.js';

const router = Router();

// Initialize services
const storyService = new StoryService();
const storageService = new StorageService();
const aiGateway = AIGatewayWithTokenTracking.fromEnvironment();

// Request schema
const StoryEditRequestSchema = z.object({
  storyId: z.string().uuid(),
  chapterNumber: z.number().int().positive().optional(),
  userRequest: z.string().min(1).max(2000)
});

/**
 * POST /story-edit
 * Edit an existing published story using AI
 */
router.post('/', async (req, res) => {
  try {
    const { storyId, chapterNumber, userRequest } = StoryEditRequestSchema.parse(req.body);

    logger.info('Story edit request received', {
      storyId,
      chapterNumber,
      userRequestLength: userRequest.length
    });

    // 1. Load story metadata from database and confirm it's published
    const story = await storyService.getStory(storyId);
    if (!story) {
      logger.warn('Story not found', { storyId });
      res.status(404).json({
        success: false,
        error: 'Story not found'
      });
      return;
    }

    if (story.status !== 'published') {
      logger.warn('Story is not published', { storyId, status: story.status });
      res.status(400).json({
        success: false,
        error: 'Story must be in published state to edit'
      });
      return;
    }

    // 2. Load story HTML from Google Storage
    if (!story.htmlUri) {
      logger.warn('Story HTML not found', { storyId });
      res.status(404).json({
        success: false,
        error: 'Story HTML not found in storage'
      });
      return;
    }

    const originalHtml = await downloadFileFromStorage(story.htmlUri);
    if (!originalHtml) {
      logger.warn('Could not download story HTML', { storyId, htmlUri: story.htmlUri });
      res.status(404).json({
        success: false,
        error: 'Could not access story HTML from storage'
      });
      return;
    }

    // 3. Extract text content based on chapter number or full story
    let textToEdit: string;
    let contextDescription: string;

    if (chapterNumber) {
      const chapterText = extractChapterText(originalHtml, chapterNumber);
      if (!chapterText) {
        logger.warn('Chapter not found in story HTML', { storyId, chapterNumber });
        res.status(404).json({
          success: false,
          error: `Chapter ${chapterNumber} not found in story`
        });
        return;
      }
      textToEdit = chapterText;
      contextDescription = `Chapter ${chapterNumber}`;
    } else {
      textToEdit = extractStoryText(originalHtml);
      contextDescription = 'Full story';
    }

    logger.info('Extracted text for editing', {
      storyId,
      chapterNumber,
      textLength: textToEdit.length,
      contextDescription
    });

    // 4. Create AI prompt for story editing
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      logger.error('Could not load story context', { storyId });
      res.status(500).json({
        success: false,
        error: 'Could not load story context'
      });
      return;
    }

    const editPrompt = await createStoryEditPrompt(
      textToEdit,
      userRequest,
      storyContext,
      contextDescription
    );

    logger.debug('Created edit prompt', {
      storyId,
      promptLength: editPrompt.length
    });

    // 5. Request changes from AI
    const aiContext = {
      authorId: storyContext.story.authorId,
      storyId: storyId,
      action: 'story_enhancement' as const // Use existing action type
    };

    const editedText = await aiGateway.getTextService(aiContext).complete(editPrompt, {
      maxTokens: 16384,
      temperature: 0.7
    });

    logger.info('AI editing completed', {
      storyId,
      originalLength: textToEdit.length,
      editedLength: editedText.length
    });

    // 6. Merge changes back into full story HTML and return
    const updatedHtml = chapterNumber 
      ? mergeChapterEdit(originalHtml, chapterNumber, editedText)
      : replaceStoryContent(originalHtml, editedText);

    logger.info('Story edit completed successfully', {
      storyId,
      chapterNumber,
      originalHtmlLength: originalHtml.length,
      updatedHtmlLength: updatedHtml.length
    });

    res.json({
      success: true,
      storyId,
      chapterNumber,
      context: contextDescription,
      userRequest,
      updatedHtml,
      metadata: {
        originalLength: textToEdit.length,
        editedLength: editedText.length,
        htmlLength: updatedHtml.length,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Story edit request failed', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.body?.storyId,
      chapterNumber: req.body?.chapterNumber
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Story editing failed'
    });
  }
});

/**
 * Download file content from Google Storage
 */
async function downloadFileFromStorage(fileUri: string): Promise<string | null> {
  try {
    // Validate the URI format
    if (!fileUri.startsWith('https://storage.googleapis.com/')) {
      logger.error('Invalid GCS URI format', { fileUri });
      return null;
    }

    // Extract the full file path from GCS URI 
    // Format: https://storage.googleapis.com/bucket-name/path/to/file.html
    const url = new URL(fileUri);
    const pathParts = url.pathname.split('/').filter(part => part.length > 0);
    
    // First element is bucket name, everything after is the file path
    if (pathParts.length < 2) {
      logger.error('Invalid file URI format - insufficient path components', { 
        fileUri, 
        pathParts 
      });
      return null;
    }

    const bucketName = pathParts[0];
    const filePath = pathParts.slice(1).join('/');
    
    if (!filePath) {
      logger.error('Invalid file URI format - no file path found', { fileUri, bucketName });
      return null;
    }
    
    logger.debug('Downloading file from storage', { 
      fileUri, 
      bucketName, 
      filePath
    });
    
    // Use the existing storage service to get the file
    const fileContent = await storageService.downloadFile(filePath);
    return fileContent;
  } catch (error) {
    logger.error('Failed to download file from storage', {
      error: error instanceof Error ? error.message : String(error),
      fileUri
    });
    return null;
  }
}

/**
 * Extract text content from a specific chapter in HTML
 */
function extractChapterText(html: string, chapterNumber: number): string | null {
  try {
    logger.info('Attempting to extract chapter text', { 
      chapterNumber,
      htmlLength: html.length,
      hasChapterDivs: html.includes('mythoria-chapter'),
      hasTargetChapterId: html.includes(`chapter-${chapterNumber}`)
    });

    // Look for Mythoria chapter structure: <div class="mythoria-chapter" id="chapter-N">
    const chapterDivRegex = new RegExp(
      `<div[^>]*class="[^"]*mythoria-chapter[^"]*"[^>]*id="chapter-${chapterNumber}"[^>]*>([\\s\\S]*?)</div>\\s*(?:<div[^>]*class="[^"]*mythoria-page-break|$)`,
      'i'
    );
    
    let match = html.match(chapterDivRegex);
    if (!match || !match[1]) {
        logger.info('ID-based chapter search failed, trying position-based search', { chapterNumber });
        
        // Try alternative: look for chapter div without strict id matching
        const altChapterRegex = /<div[^>]*class="[^"]*mythoria-chapter[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div[^>]*class="[^"]*mythoria-page-break|$)/gi;
        
        let chapterIndex = 0;
        let altMatch;
        
        // Find the specific chapter by counting occurrences
        while ((altMatch = altChapterRegex.exec(html)) !== null) {
          chapterIndex++;
          logger.info('Found chapter div', { foundIndex: chapterIndex, targetIndex: chapterNumber });
          if (chapterIndex === chapterNumber) {
            match = altMatch;
            break;
          }
        }
        
        if (!match || !match[1]) {
          logger.info('Chapter div not found, trying simple numeric search', { chapterNumber, totalChaptersFound: chapterIndex });
        
        // Fallback: look for any heading with the chapter number
        const fallbackRegex = new RegExp(
          `<h2[^>]*>[^<]*${chapterNumber}[^<]*</h2>([\\s\\S]*?)(?=<h2[^>]*>|<div[^>]*class="[^"]*mythoria-page-break|$)`,
          'i'
        );
        
        const fallbackMatch = html.match(fallbackRegex);        if (fallbackMatch && fallbackMatch[1]) {
          logger.info('Found chapter using fallback regex', { chapterNumber });
          return extractTextFromHtml(fallbackMatch[1]);
        }
        
        logger.warn('No chapter extraction method succeeded', { chapterNumber, totalChaptersFound: chapterIndex });
        return null;
      }
    }
      logger.info('Successfully found chapter content', { 
      chapterNumber,
      contentLength: match[1].length,
      hasContentDiv: match[1].includes('mythoria-chapter-content')
    });
    
    // Extract content from chapter div
    const chapterContent = match[1];
    
    // Try to extract just the chapter content div if it exists
    const contentMatch = chapterContent.match(/<div[^>]*class="[^"]*mythoria-chapter-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      if (contentMatch && contentMatch[1]) {
      const extractedText = extractTextFromHtml(contentMatch[1]);
      logger.info('Extracted text from chapter content div', { 
        chapterNumber,
        extractedLength: extractedText.length,
        preview: extractedText.substring(0, 100) + '...'
      });
      return extractedText;
    }
    
    // Fallback: extract all text from the chapter div
    const extractedText = extractTextFromHtml(chapterContent);
    logger.info('Extracted text from full chapter div', { 
      chapterNumber,
      extractedLength: extractedText.length,
      preview: extractedText.substring(0, 100) + '...'
    });
    return extractedText;
    
  } catch (error) {
    logger.error('Failed to extract chapter text', {
      error: error instanceof Error ? error.message : String(error),
      chapterNumber
    });
    return null;
  }
}

/**
 * Extract all story text content from HTML (excluding headers, navigation, etc.)
 */
function extractStoryText(html: string): string {
  try {
    // Extract content from all Mythoria chapters
    const chaptersRegex = /<div[^>]*class="[^"]*mythoria-chapter[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div[^>]*class="[^"]*mythoria-page-break|$)/gi;
    
    let allChapterText = '';
    let match;
    
    while ((match = chaptersRegex.exec(html)) !== null) {
      if (match[1]) {
        // Try to extract just the chapter content div
        const contentMatch = match[1].match(/<div[^>]*class="[^"]*mythoria-chapter-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        
        if (contentMatch && contentMatch[1]) {
          allChapterText += extractTextFromHtml(contentMatch[1]) + '\n\n';
        } else {
          // Fallback: extract all text from the chapter div
          allChapterText += extractTextFromHtml(match[1]) + '\n\n';
        }
      }
    }
    
    if (allChapterText.trim()) {
      return allChapterText.trim();
    }
    
    // Fallback: extract content from main story area or body
    const contentMatch = html.match(/<main[^>]*>([\s\S]*)<\/main>/i) ||
                         html.match(/<div[^>]*class="[^"]*story[^"]*"[^>]*>([\s\S]*)<\/div>/i) ||
                         html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    
    if (!contentMatch || !contentMatch[1]) {
      // Final fallback: extract all text content
      return extractTextFromHtml(html);
    }
    
    return extractTextFromHtml(contentMatch[1]);
  } catch (error) {
    logger.error('Failed to extract story text', {
      error: error instanceof Error ? error.message : String(error)
    });
    return extractTextFromHtml(html);
  }
}

/**
 * Extract plain text from HTML content
 */
function extractTextFromHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove scripts
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // Remove styles
    .replace(/<[^>]+>/g, ' ') // Remove HTML tags
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

/**
 * Create the AI prompt for story editing
 */
async function createStoryEditPrompt(
  originalText: string, 
  userRequest: string, 
  storyContext: any,
  contextDescription: string
): Promise<string> {
  
  try {
    // Load the story editing prompt template
    const promptTemplate = await PromptService.loadPrompt('en-US', 'story-edit');
    
    // Prepare template variables
    const templateVariables = {
      contextDescription: contextDescription.toLowerCase(),
      userRequest: userRequest,
      originalText: originalText,
      storyTitle: storyContext.story.title,
      novelStyle: storyContext.story.novelStyle || 'adventure',
      targetAudience: formatTargetAudience(storyContext.story.targetAudience),
      language: getLanguageName(storyContext.story.storyLanguage),
      storySetting: storyContext.story.place || 'Not specified'
    };
    
    // Build the complete prompt using the template
    return PromptService.buildPrompt(promptTemplate, templateVariables);
    
  } catch (error) {
    logger.error('Failed to load story edit prompt template, using fallback', {
      error: error instanceof Error ? error.message : String(error)
    });
    
    // Fallback prompt if template loading fails
    const systemPrompt = `You are an award-winning book editor and writer specializing in ${storyContext.story.novelStyle || 'adventure'} stories. You are helping to edit ${contextDescription.toLowerCase()} of an existing published story based on the user's specific request.

Your task is to:
1. Carefully read the original text
2. Understand the user's editing request
3. Make the requested changes while maintaining the story's voice, style, and continuity
4. Preserve the overall narrative structure and character consistency
5. Ensure the edited content flows naturally with the rest of the story

IMPORTANT GUIDELINES:
- Keep the same writing style and tone as the original
- Maintain character consistency and development
- Preserve the story's genre (${storyContext.story.novelStyle || 'adventure'}) and target audience (${formatTargetAudience(storyContext.story.targetAudience)})
- Write in ${getLanguageName(storyContext.story.storyLanguage)}
- Only make changes that are specifically requested
- Return ONLY the edited text content, no explanations or comments`;

    const userPrompt = `Please edit the following ${contextDescription.toLowerCase()} according to this request:

USER'S EDITING REQUEST:
"${userRequest}"

ORIGINAL TEXT TO EDIT:
\`\`\`
${originalText}
\`\`\`

STORY CONTEXT:
- Title: ${storyContext.story.title}
- Genre: ${storyContext.story.novelStyle || 'adventure'}
- Target Audience: ${formatTargetAudience(storyContext.story.targetAudience)}
- Language: ${getLanguageName(storyContext.story.storyLanguage)}
- Setting: ${storyContext.story.place || 'Not specified'}

Return only the edited text that incorporates the requested changes while maintaining the story's original style and voice.`;

    return `${systemPrompt}\n\n${userPrompt}`;
  }
}

/**
 * Merge edited chapter content back into full HTML
 */
function mergeChapterEdit(fullHtml: string, chapterNumber: number, editedText: string): string {
  try {
    // Find the Mythoria chapter structure
    const chapterDivRegex = new RegExp(
      `(<div[^>]*class="[^"]*mythoria-chapter[^"]*"[^>]*id="chapter-${chapterNumber}"[^>]*>[\\s\\S]*?<div[^>]*class="[^"]*mythoria-chapter-content[^"]*"[^>]*>)([\\s\\S]*?)(<\\/div>[\\s\\S]*?<\\/div>)`,
      'i'
    );
    
    let match = fullHtml.match(chapterDivRegex);
    
    if (!match) {
      // Try to find chapter by position if ID-based search fails
      const allChaptersRegex = /<div[^>]*class="[^"]*mythoria-chapter[^"]*"[^>]*>/gi;
      const chapters = [...fullHtml.matchAll(allChaptersRegex)];
        if (chapters.length >= chapterNumber) {
        // Find the specific chapter by counting
        const chapterMatch = chapters[chapterNumber - 1];
        const chapterStartIndex = chapterMatch?.index;
        if (chapterStartIndex !== undefined) {
          const chapterEndRegex = /<\/div>\s*(?:<div[^>]*class="[^"]*mythoria-page-break|$)/g;
          chapterEndRegex.lastIndex = chapterStartIndex;
          const endMatch = chapterEndRegex.exec(fullHtml);
          
          if (endMatch) {
            const chapterHtml = fullHtml.substring(chapterStartIndex, endMatch.index + 6); // +6 for </div>
            
            // Extract and replace content within this chapter
            const contentRegex = /(<div[^>]*class="[^"]*mythoria-chapter-content[^"]*"[^>]*>)([\s\S]*?)(<\/div>)/i;
            const contentMatch = chapterHtml.match(contentRegex);
            
            if (contentMatch) {
              const newChapterHtml = chapterHtml.replace(contentRegex, `$1\n${formatTextAsHtml(editedText)}\n$3`);
              return fullHtml.substring(0, chapterStartIndex) + newChapterHtml + fullHtml.substring(endMatch.index + 6);
            }
          }
        }
      }
      
      logger.warn('Could not find chapter in HTML for merging', { chapterNumber });
      return fullHtml; // Return original if can't find chapter
    }
    
    // Replace the chapter content while preserving the structure
    const newChapterContent = `${match[1]}\n${formatTextAsHtml(editedText)}\n${match[3]}`;
    
    return fullHtml.replace(chapterDivRegex, newChapterContent);
  } catch (error) {
    logger.error('Failed to merge chapter edit', {
      error: error instanceof Error ? error.message : String(error),
      chapterNumber
    });
    return fullHtml; // Return original on error
  }
}

/**
 * Replace entire story content in HTML
 */
function replaceStoryContent(fullHtml: string, editedText: string): string {
  try {
    // Try to find main content area and replace it
    const contentRegex = /<main[^>]*>([\s\S]*)<\/main>/i;
    const match = fullHtml.match(contentRegex);
    
    if (match) {
      const newContent = `<main>\n${formatTextAsHtml(editedText)}\n</main>`;
      return fullHtml.replace(contentRegex, newContent);
    }
    
    // Fallback: replace body content
    const bodyRegex = /(<body[^>]*>)([\s\S]*)(<\/body>)/i;
    const bodyMatch = fullHtml.match(bodyRegex);
    
    if (bodyMatch) {
      const newBodyContent = `${bodyMatch[1]}\n${formatTextAsHtml(editedText)}\n${bodyMatch[3]}`;
      return fullHtml.replace(bodyRegex, newBodyContent);
    }
    
    return fullHtml; // Return original if can't parse structure
  } catch (error) {
    logger.error('Failed to replace story content', {
      error: error instanceof Error ? error.message : String(error)
    });
    return fullHtml;
  }
}

/**
 * Format plain text as HTML paragraphs with Mythoria classes
 */
function formatTextAsHtml(text: string): string {
  return text
    .split('\n\n') // Split into paragraphs
    .filter(paragraph => paragraph.trim().length > 0)
    .map(paragraph => {
      const cleanParagraph = paragraph.trim();
      // Skip if it's already HTML or markdown heading
      if (cleanParagraph.startsWith('<') || cleanParagraph.startsWith('#')) {
        return `<p class="mythoria-chapter-paragraph">${cleanParagraph}</p>`;
      }
      return `<p class="mythoria-chapter-paragraph">${cleanParagraph}</p>`;
    })
    .join('\n');
}

export { router as storyEditRouter };
