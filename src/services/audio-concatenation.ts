/**
 * Audio Concatenation Service
 * Concatenates multiple MP3 audio buffers into a single file using FFmpeg
 * Uses the concat demuxer for lossless joining (no re-encoding)
 */

import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { logger } from '@/config/logger.js';

// Set ffmpeg path from installer
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Result of audio concatenation
 */
export interface ConcatenationResult {
  /** The concatenated audio buffer */
  buffer: Buffer;
  /** Number of chunks that were concatenated */
  chunkCount: number;
  /** Total size in bytes */
  totalSize: number;
}

/**
 * Concatenate multiple MP3 audio buffers into a single MP3 file
 * Uses FFmpeg concat demuxer for lossless joining
 *
 * @param buffers Array of MP3 audio buffers to concatenate
 * @returns Single concatenated MP3 buffer
 */
export async function concatenateAudioBuffers(buffers: Buffer[]): Promise<ConcatenationResult> {
  // Handle edge cases
  if (!buffers || buffers.length === 0) {
    throw new Error('No audio buffers provided for concatenation');
  }

  // Single buffer - return as-is
  if (buffers.length === 1) {
    const singleBuffer = buffers[0];
    if (!singleBuffer) {
      throw new Error('Buffer at index 0 is undefined');
    }
    return {
      buffer: singleBuffer,
      chunkCount: 1,
      totalSize: singleBuffer.length,
    };
  }

  logger.info('Starting audio concatenation', {
    chunkCount: buffers.length,
    totalInputSize: buffers.reduce((sum, b) => sum + b.length, 0),
  });

  // Create unique temp directory for this operation
  const tempDir = join(tmpdir(), `mythoria-audio-concat-${randomUUID()}`);
  const tempFiles: string[] = [];
  const listFilePath = join(tempDir, 'concat-list.txt');
  const outputFilePath = join(tempDir, 'output.mp3');

  try {
    // Create temp directory
    await fs.mkdir(tempDir, { recursive: true });

    // Write each buffer to a temp file
    for (let i = 0; i < buffers.length; i++) {
      const chunkBuffer = buffers[i];
      if (!chunkBuffer) {
        throw new Error(`Buffer at index ${i} is undefined`);
      }
      const chunkPath = join(tempDir, `chunk_${String(i).padStart(4, '0')}.mp3`);
      await fs.writeFile(chunkPath, chunkBuffer);
      tempFiles.push(chunkPath);
    }

    // Create FFmpeg concat list file
    // Format: file 'path/to/file.mp3' (one per line)
    const listContent = tempFiles
      .map((filePath) => `file '${filePath.replace(/\\/g, '/')}'`)
      .join('\n');
    await fs.writeFile(listFilePath, listContent);

    // Run FFmpeg concatenation
    await runFFmpegConcat(listFilePath, outputFilePath);

    // Read the output file
    const outputBuffer = await fs.readFile(outputFilePath);

    logger.info('Audio concatenation complete', {
      chunkCount: buffers.length,
      outputSize: outputBuffer.length,
    });

    return {
      buffer: outputBuffer,
      chunkCount: buffers.length,
      totalSize: outputBuffer.length,
    };
  } catch (error) {
    logger.error('Audio concatenation failed', {
      error: error instanceof Error ? error.message : String(error),
      chunkCount: buffers.length,
    });
    throw error;
  } finally {
    // Always cleanup temp files
    await cleanupTempFiles(tempDir, tempFiles, listFilePath, outputFilePath);
  }
}

/**
 * Run FFmpeg concat demuxer to join audio files
 */
function runFFmpegConcat(listFilePath: string, outputFilePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFilePath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy']) // Lossless copy - no re-encoding
      .output(outputFilePath)
      .on('start', (commandLine: string) => {
        logger.debug('FFmpeg concat started', { commandLine });
      })
      .on('error', (err: Error, _stdout?: string, stderr?: string) => {
        logger.error('FFmpeg concat error', {
          error: err.message,
          stderr,
        });
        reject(new Error(`FFmpeg concat failed: ${err.message}`));
      })
      .on('end', () => {
        logger.debug('FFmpeg concat finished');
        resolve();
      })
      .run();
  });
}

/**
 * Clean up temporary files created during concatenation
 */
async function cleanupTempFiles(
  tempDir: string,
  chunkFiles: string[],
  listFile: string,
  outputFile: string,
): Promise<void> {
  const filesToDelete = [...chunkFiles, listFile, outputFile];

  for (const filePath of filesToDelete) {
    try {
      await fs.unlink(filePath);
    } catch {
      // File may not exist, ignore
    }
  }

  try {
    await fs.rmdir(tempDir);
  } catch {
    // Directory may not be empty or not exist, ignore
  }
}

/**
 * Validate that a buffer contains valid MP3 data
 * Checks for MP3 frame sync word or ID3 tag
 */
export function isValidMp3Buffer(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 3) {
    return false;
  }

  // Check for ID3v2 tag (starts with "ID3")
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return true;
  }

  // Check for MP3 frame sync (0xFF followed by 0xE* or 0xF*)
  const byte0 = buffer[0];
  const byte1 = buffer[1];
  if (byte0 !== undefined && byte1 !== undefined && byte0 === 0xff && (byte1 & 0xe0) === 0xe0) {
    return true;
  }

  return false;
}

/**
 * Get estimated duration of MP3 audio in seconds
 * This is a rough estimate based on file size and typical bitrate
 */
export function estimateAudioDuration(buffer: Buffer, bitrateKbps: number = 128): number {
  // Duration = (file size in bits) / (bitrate in bits per second)
  const fileSizeBits = buffer.length * 8;
  const bitrateBps = bitrateKbps * 1000;
  return fileSizeBits / bitrateBps;
}

// -----------------------------------------------------------------------------
// Audio Mixing with Background Music
// -----------------------------------------------------------------------------

/**
 * Options for mixing narration with background music
 */
export interface AudioMixOptions {
  /** Volume of background music (0.0 to 1.0), default 0.2 (20%) */
  backgroundVolume?: number;
  /** Fade in duration in seconds for background music, default 1.5 */
  fadeInDuration?: number;
  /** Fade out duration in seconds for background music, default 1.5 */
  fadeOutDuration?: number;
}

/**
 * Result of audio mixing operation
 */
export interface AudioMixResult {
  /** The mixed audio buffer */
  buffer: Buffer;
  /** Whether background music was successfully mixed */
  hasMixedBackground: boolean;
  /** The background music file used (if any) */
  backgroundMusicFile?: string;
}

/**
 * Mix narration audio with background music using FFmpeg
 * Background music is looped if shorter than narration and faded in/out
 *
 * @param narrationBuffer MP3 buffer of the narration audio
 * @param backgroundMusicPath Path to the background music MP3 file
 * @param options Mixing options (volume, fade durations)
 * @returns Mixed audio buffer
 */
export async function mixAudioWithBackground(
  narrationBuffer: Buffer,
  backgroundMusicPath: string,
  options: AudioMixOptions = {},
): Promise<AudioMixResult> {
  const { backgroundVolume = 0.2, fadeInDuration = 1.5, fadeOutDuration = 1.5 } = options;

  logger.info('Starting audio mixing with background music', {
    narrationSize: narrationBuffer.length,
    backgroundMusicPath,
    backgroundVolume,
    fadeInDuration,
    fadeOutDuration,
  });

  // Create unique temp directory for this operation
  const tempDir = join(tmpdir(), `mythoria-audio-mix-${randomUUID()}`);
  const narrationPath = join(tempDir, 'narration.mp3');
  const outputPath = join(tempDir, 'mixed.mp3');

  try {
    // Create temp directory
    await fs.mkdir(tempDir, { recursive: true });

    // Write narration buffer to temp file
    await fs.writeFile(narrationPath, narrationBuffer);

    // Run FFmpeg mixing
    await runFFmpegMix(narrationPath, backgroundMusicPath, outputPath, {
      backgroundVolume,
      fadeInDuration,
      fadeOutDuration,
    });

    // Read the mixed output
    const mixedBuffer = await fs.readFile(outputPath);

    logger.info('Audio mixing completed successfully', {
      inputSize: narrationBuffer.length,
      outputSize: mixedBuffer.length,
      backgroundMusicPath,
    });

    return {
      buffer: mixedBuffer,
      hasMixedBackground: true,
      backgroundMusicFile: backgroundMusicPath,
    };
  } catch (error) {
    logger.error('Audio mixing failed, returning original narration', {
      error: error instanceof Error ? error.message : String(error),
      backgroundMusicPath,
    });

    // Return original narration if mixing fails
    return {
      buffer: narrationBuffer,
      hasMixedBackground: false,
    };
  } finally {
    // Cleanup temp files
    await cleanupMixTempFiles(tempDir, narrationPath, outputPath);
  }
}

/**
 * Run FFmpeg to mix narration with background music
 * Uses amix filter with looped and faded background music
 */
function runFFmpegMix(
  narrationPath: string,
  backgroundMusicPath: string,
  outputPath: string,
  options: Required<AudioMixOptions>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { backgroundVolume, fadeInDuration } = options;

    // Build complex filter:
    // 1. [0:a] = narration (main audio, full volume)
    // 2. [1:a] = background music (looped, volume reduced, faded in/out)
    // 3. amix = combine both streams
    //
    // The filter graph:
    // - aloop loops the background music (-1 = infinite until shortest)
    // - afade applies fade in at start
    // - volume reduces background level
    // - amix combines with shortest duration (narration)
    // - dropout_transition provides smooth fade out when narration ends
    const simpleFilter = [
      // Prepare narration
      '[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[narration]',
      // Loop background, apply fade in and volume reduction
      `[1:a]aloop=loop=-1:size=2e+09,afade=t=in:st=0:d=${fadeInDuration},volume=${backgroundVolume}[bg]`,
      // Mix with shortest duration; dropout_transition fades out background when narration ends
      '[narration][bg]amix=inputs=2:duration=shortest:dropout_transition=2[mixed]',
    ].join(';');

    ffmpeg()
      .input(narrationPath)
      .input(backgroundMusicPath)
      .complexFilter(simpleFilter, 'mixed')
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .output(outputPath)
      .on('start', (commandLine: string) => {
        logger.debug('FFmpeg mix started', { commandLine });
      })
      .on('error', (err: Error, _stdout?: string, stderr?: string) => {
        logger.error('FFmpeg mix error', {
          error: err.message,
          stderr,
        });
        reject(new Error(`FFmpeg mix failed: ${err.message}`));
      })
      .on('end', () => {
        logger.debug('FFmpeg mix finished');
        resolve();
      })
      .run();
  });
}

/**
 * Clean up temporary files created during mixing
 */
async function cleanupMixTempFiles(
  tempDir: string,
  narrationPath: string,
  outputPath: string,
): Promise<void> {
  const filesToDelete = [narrationPath, outputPath];

  for (const filePath of filesToDelete) {
    try {
      await fs.unlink(filePath);
    } catch {
      // File may not exist, ignore
    }
  }

  try {
    await fs.rmdir(tempDir);
  } catch {
    // Directory may not be empty or not exist, ignore
  }
}
