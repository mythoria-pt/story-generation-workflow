import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { execFile } from 'child_process';
import { mixAudioWithBackground } from '@/services/audio-concatenation.js';

let ffmpegError: Error | null = null;

jest.mock('child_process', () => ({
  execFile: jest.fn(
    (
      _file: string,
      args: string[],
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (args.includes('-filter_complex')) {
        callback(ffmpegError, '', ffmpegError ? 'unsupported filter' : '');
        return;
      }
      callback(null, '', 'Duration: 00:01:40.00, start: 0.000000, bitrate: 128 kb/s');
    },
  ),
}));

function mixFilter() {
  const args = jest
    .mocked(execFile)
    .mock.calls.map(([, args]) => args)
    .find((args) => Array.isArray(args) && args.includes('-filter_complex'));
  if (!Array.isArray(args)) throw new Error('FFmpeg did not receive a filter graph');
  return args[args.indexOf('-filter_complex') + 1]!;
}

// Mock fs/promises to prevent file system operations during unit tests
jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(Buffer.from('mock-mixed-audio')),
  unlink: jest.fn().mockResolvedValue(undefined),
  rmdir: jest.fn().mockResolvedValue(undefined),
}));

describe('Audio Mixing Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ffmpegError = null;
  });

  test('should mix narration and background music with correct default volume parameters', async () => {
    const narrationBuffer = Buffer.from('mock-narration');
    const backgroundMusicPath = 'path/to/music.mp3';

    await mixAudioWithBackground(narrationBuffer, backgroundMusicPath);

    // Verify FFmpeg filter setup
    const filterString = mixFilter();

    // Default volume parameters should be used
    expect(filterString).toContain('volume=1'); // Narration volume defaults to 1.0
    expect(filterString).toContain('volume=0.1'); // Background volume defaults to 0.1
    expect(filterString).toContain('normalize=0'); // Normalize set to 0 to prevent volume halving
    expect(filterString).toContain('alimiter=limit=0.95');
    expect(filterString).toContain('amix=inputs=2');
  });

  test('should apply custom narrationVolume and backgroundVolume correctly', async () => {
    const narrationBuffer = Buffer.from('mock-narration');
    const backgroundMusicPath = 'path/to/music.mp3';

    await mixAudioWithBackground(narrationBuffer, backgroundMusicPath, {
      narrationVolume: 1.5,
      backgroundVolume: 0.1,
    });

    const filterString = mixFilter();

    expect(filterString).toContain('volume=1.5'); // Custom narration volume
    expect(filterString).toContain('volume=0.1'); // Custom background volume
    expect(filterString).toContain('normalize=0');
  });

  test('should apply music-only fade in and late fade out using the narration duration', async () => {
    const narrationBuffer = Buffer.from('mock-narration');
    const backgroundMusicPath = 'path/to/music.mp3';

    await mixAudioWithBackground(narrationBuffer, backgroundMusicPath, {
      fadeInDuration: 4,
      fadeOutDuration: 4,
    });

    const filterString = mixFilter();
    const filterParts = filterString.split(';');
    const narrationFilter = filterParts[0];
    const backgroundFilter = filterParts[1];

    expect(narrationFilter).not.toContain('afade');
    expect(backgroundFilter).toContain('afade=t=in:st=0:d=2');
    expect(backgroundFilter).toContain('afade=t=out:st=98:d=2');
    expect(filterString).toContain('amix=inputs=2:duration=first');
  });

  test('should fail explicitly when requested background music cannot be mixed', async () => {
    ffmpegError = new Error("Option 'normalize' not found");

    await expect(
      mixAudioWithBackground(Buffer.from('mock-narration'), 'path/to/music.mp3'),
    ).rejects.toMatchObject({
      code: 'FFMPEG_MIX_FAILED',
      statusCode: 424,
      retryable: false,
    });
  });
});
