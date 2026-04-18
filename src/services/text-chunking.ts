/**
 * Text Chunking Service
 * Intelligently splits long text into chunks that respect natural language boundaries
 * (paragraphs, sentences) for seamless TTS audio generation.
 */

import { logger } from '@/config/logger.js';

/**
 * Options for text chunking behavior
 */
export interface ChunkingOptions {
  /** Prefer paragraph breaks over sentence breaks (default: true) */
  preferParagraphs?: boolean;
  /** Minimum chunk size in characters to avoid tiny chunks (default: 500) */
  minChunkSize?: number;
  /** Try to keep dialogue together within a chunk (default: true) */
  preserveDialogue?: boolean;
}

/**
 * Represents a chunk of text with metadata
 */
export interface TextChunk {
  /** The actual text content */
  text: string;
  /** Zero-based index of this chunk */
  index: number;
  /** Character offset where this chunk starts in original text */
  startOffset: number;
  /** Character offset where this chunk ends in original text */
  endOffset: number;
}

/**
 * Common abbreviations that should NOT be treated as sentence endings
 * These patterns are common across supported locales (en-US, pt-PT, es-ES, fr-FR, de-DE)
 */
const ABBREVIATIONS = new Set([
  // English titles
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  // Common abbreviations
  'vs',
  'etc',
  'inc',
  'ltd',
  'co',
  'corp',
  // Units and measures
  'ft',
  'in',
  'lb',
  'oz',
  'pt',
  'qt',
  'gal',
  'mi',
  'km',
  'kg',
  'mg',
  'ml',
  // Ordinals and references
  'no',
  'vol',
  'ch',
  'pg',
  'pp',
  'ed',
  'rev',
  // Portuguese/Spanish/French titles
  'sr',
  'sra',
  'srta',
  'dn',
  'dna',
  'dra',
  // German titles
  'hr',
  'fr',
  // Time-related
  'a.m',
  'p.m',
  'am',
  'pm',
]);

/**
 * Check if a word ending with period is an abbreviation
 */
function isAbbreviation(word: string): boolean {
  // Remove the period and convert to lowercase
  const cleanWord = word.replace(/\.$/, '').toLowerCase();
  return ABBREVIATIONS.has(cleanWord);
}

/**
 * Split text into paragraphs based on double newlines or significant whitespace
 */
export function splitByParagraphs(text: string): string[] {
  // Split on double newlines (with optional extra whitespace)
  const paragraphs = text.split(/\n\s*\n/);

  // Filter out empty paragraphs and trim whitespace
  return paragraphs.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Split text into sentences using regex-based boundary detection
 * Handles edge cases like abbreviations, dialogue, and decimal numbers
 */
export function splitBySentences(text: string): string[] {
  const sentences: string[] = [];
  let currentSentence = '';
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    currentSentence += char;

    // Check for potential sentence ending
    if (char === '.' || char === '!' || char === '?') {
      // Look ahead to see if this is a real sentence boundary
      const nextChar = text[i + 1];
      const afterNextChar = text[i + 2];

      // Handle ellipsis (...)
      if (char === '.' && nextChar === '.' && afterNextChar === '.') {
        currentSentence += '..';
        i += 3;
        continue;
      }

      // Check if followed by closing quote (straight or curly quotes)
      if (nextChar === '"' || nextChar === "'" || nextChar === '\u201D' || nextChar === '\u2019') {
        currentSentence += nextChar;
        i++;
      }

      // Get the word before the punctuation to check for abbreviations
      const beforePunct = currentSentence.slice(0, -1);
      const words = beforePunct.split(/\s+/);
      const lastWord = words[words.length - 1];

      // Check if this is an abbreviation
      if (char === '.' && lastWord && isAbbreviation(lastWord + '.')) {
        i++;
        continue;
      }

      // Check if this looks like a decimal number (e.g., "3.14")
      if (char === '.' && nextChar && /\d/.test(nextChar)) {
        const prevChar = text[i - 1];
        if (prevChar && /\d/.test(prevChar)) {
          i++;
          continue;
        }
      }

      // Check if followed by whitespace and uppercase (sentence boundary)
      // or end of text
      const lookAhead = text.slice(i + 1, i + 10).trimStart();
      if (
        !lookAhead ||
        lookAhead.length === 0 ||
        /^[A-Z\u00C0-\u00DC"'\u201C\u201D\u2018\u2019[[]/.test(lookAhead) ||
        /^\n/.test(text.slice(i + 1, i + 3))
      ) {
        // This is a sentence boundary
        sentences.push(currentSentence.trim());
        currentSentence = '';
      }
    }

    i++;
  }

  // Don't forget any remaining text
  if (currentSentence.trim()) {
    sentences.push(currentSentence.trim());
  }

  return sentences.filter((s) => s.length > 0);
}

/**
 * Split a very long sentence at secondary boundaries (commas, semicolons, colons)
 */
function splitLongSentence(sentence: string, maxSize: number): string[] {
  if (sentence.length <= maxSize) {
    return [sentence];
  }

  const chunks: string[] = [];
  let current = '';

  // Split at commas, semicolons, colons, or dashes
  const parts = sentence.split(/([,;:\u2014\u2013-]\s*)/);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';

    if (current.length + part.length <= maxSize) {
      current += part;
    } else {
      if (current.trim()) {
        chunks.push(current.trim());
      }
      current = part;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  // If any chunk is still too long, hard split at maxSize
  return chunks.flatMap((chunk) => {
    if (chunk.length <= maxSize) {
      return [chunk];
    }
    // Hard split as last resort
    const hardChunks: string[] = [];
    for (let i = 0; i < chunk.length; i += maxSize - 50) {
      // Leave some buffer
      hardChunks.push(chunk.slice(i, i + maxSize - 50));
    }
    return hardChunks;
  });
}

/**
 * Merge segments into chunks that don't exceed maxSize
 * Uses a greedy algorithm to maximize chunk utilization
 */
function mergeSegmentsToLimit(
  segments: string[],
  maxSize: number,
  minChunkSize: number,
): TextChunk[] {
  const chunks: TextChunk[] = [];
  let currentText = '';
  let currentStartOffset = 0;
  let runningOffset = 0;

  for (const segment of segments) {
    const segmentWithSpace = currentText ? ' ' + segment : segment;

    // Check if adding this segment would exceed the limit
    if (currentText.length + segmentWithSpace.length > maxSize) {
      // Save current chunk if it meets minimum size
      if (currentText.length >= minChunkSize || chunks.length === 0) {
        chunks.push({
          text: currentText,
          index: chunks.length,
          startOffset: currentStartOffset,
          endOffset: runningOffset,
        });
      } else if (chunks.length > 0) {
        // Append to previous chunk if current is too small
        const lastChunk = chunks[chunks.length - 1];
        if (lastChunk) {
          lastChunk.text += ' ' + currentText;
          lastChunk.endOffset = runningOffset;
        }
      }

      // Start new chunk
      currentText = segment;
      currentStartOffset = runningOffset;
    } else {
      currentText += segmentWithSpace;
    }

    runningOffset += segment.length + 1; // +1 for space
  }

  // Don't forget the last chunk
  if (currentText.trim()) {
    if (currentText.length >= minChunkSize || chunks.length === 0) {
      chunks.push({
        text: currentText,
        index: chunks.length,
        startOffset: currentStartOffset,
        endOffset: runningOffset,
      });
    } else if (chunks.length > 0) {
      // Append to previous chunk
      const lastChunk = chunks[chunks.length - 1];
      if (lastChunk) {
        lastChunk.text += ' ' + currentText;
        lastChunk.endOffset = runningOffset;
      }
    }
  }

  // Re-index chunks
  return chunks.map((chunk, index) => ({ ...chunk, index }));
}

/**
 * Main entry point: Split text into chunks that respect natural boundaries
 *
 * @param text The text to split
 * @param maxSize Maximum characters per chunk (provider limit)
 * @param options Chunking behavior options
 * @returns Array of text chunks with metadata
 */
export function splitTextIntoChunks(
  text: string,
  maxSize: number,
  options: ChunkingOptions = {},
): TextChunk[] {
  const { preferParagraphs = true, minChunkSize = 500, preserveDialogue = true } = options;

  // If text is already within limit, return as single chunk
  if (text.length <= maxSize) {
    return [
      {
        text,
        index: 0,
        startOffset: 0,
        endOffset: text.length,
      },
    ];
  }

  logger.info('Splitting text into chunks', {
    textLength: text.length,
    maxSize,
    preferParagraphs,
    minChunkSize,
  });

  let segments: string[];

  // First, try splitting by paragraphs if preferred
  if (preferParagraphs) {
    const paragraphs = splitByParagraphs(text);

    // Check if any paragraph is still too long
    const needsSentenceSplit = paragraphs.some((p) => p.length > maxSize);

    if (needsSentenceSplit) {
      // Split long paragraphs into sentences
      segments = paragraphs.flatMap((paragraph) => {
        if (paragraph.length <= maxSize) {
          return [paragraph];
        }
        // This paragraph is too long, split into sentences
        const sentences = splitBySentences(paragraph);

        // Check if any sentence is still too long
        return sentences.flatMap((sentence) => splitLongSentence(sentence, maxSize));
      });
    } else {
      segments = paragraphs;
    }
  } else {
    // Split directly by sentences
    const sentences = splitBySentences(text);
    segments = sentences.flatMap((sentence) => splitLongSentence(sentence, maxSize));
  }

  // Handle dialogue preservation by merging quotes that got split
  if (preserveDialogue) {
    segments = mergeDialogueSegments(segments, maxSize);
  }

  // Merge segments into chunks that respect maxSize
  const chunks = mergeSegmentsToLimit(segments, maxSize, minChunkSize);

  logger.info('Text splitting complete', {
    originalLength: text.length,
    chunkCount: chunks.length,
    avgChunkSize: Math.round(text.length / chunks.length),
  });

  return chunks;
}

/**
 * Attempt to keep dialogue (quoted text) together within chunks
 */
function mergeDialogueSegments(segments: string[], maxSize: number): string[] {
  const merged: string[] = [];
  let dialogueBuffer = '';
  let inDialogue = false;

  for (const segment of segments) {
    const openQuotes = (segment.match(/[""\u201C]/g) || []).length;
    const closeQuotes = (segment.match(/[""\u201D]/g) || []).length;

    if (inDialogue) {
      dialogueBuffer += ' ' + segment;

      // Check if dialogue closes
      if (closeQuotes > openQuotes || closeQuotes >= 1) {
        inDialogue = false;
        // Only push merged dialogue if within limit
        if (dialogueBuffer.length <= maxSize) {
          merged.push(dialogueBuffer);
        } else {
          // Dialogue too long, split it
          merged.push(...dialogueBuffer.split(/(?<=[.!?])\s+/));
        }
        dialogueBuffer = '';
      }
    } else {
      // Check if dialogue starts but doesn't close
      if (openQuotes > closeQuotes) {
        inDialogue = true;
        dialogueBuffer = segment;
      } else {
        merged.push(segment);
      }
    }
  }

  // Handle any unclosed dialogue
  if (dialogueBuffer) {
    merged.push(dialogueBuffer);
  }

  return merged;
}

/**
 * Check if text needs to be chunked based on provider limit
 */
export function needsChunking(text: string, maxSize: number): boolean {
  return text.length > maxSize;
}

/**
 * Estimate the number of chunks that will be generated
 */
export function estimateChunkCount(text: string, maxSize: number): number {
  if (text.length <= maxSize) {
    return 1;
  }
  // Estimate based on average utilization (usually ~80% of max)
  const avgChunkSize = maxSize * 0.8;
  return Math.ceil(text.length / avgChunkSize);
}
