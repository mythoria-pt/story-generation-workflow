import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { mixAudioWithBackground } from '@/services/audio-concatenation.js';

// Mock fluent-ffmpeg
const mockRun = jest.fn();
const mockComplexFilter = jest.fn().mockReturnThis();
const mockInput = jest.fn().mockReturnThis();
const mockMap = jest.fn().mockReturnThis();
const mockOutput = jest.fn().mockReturnThis();
const mockOn = jest.fn().mockImplementation(function (this: any, event: string, callback: any) {
  if (event === 'end') {
    process.nextTick(() => callback());
  }
  return this;
});

jest.mock('fluent-ffmpeg', () => {
  const ffmpegMock = jest.fn().mockImplementation(() => ({
    input: mockInput,
    complexFilter: mockComplexFilter,
    map: mockMap,
    output: mockOutput,
    on: mockOn,
    run: mockRun,
  }));
  (ffmpegMock as any).setFfmpegPath = jest.fn();
  return ffmpegMock;
});

jest.mock('child_process', () => ({
  execFile: jest.fn((_file, _args, callback) => {
    callback(null, '', 'Duration: 00:01:40.00, start: 0.000000, bitrate: 128 kb/s');
  }),
}));

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
  });

  test('should mix narration and background music with correct default volume parameters', async () => {
    const narrationBuffer = Buffer.from('mock-narration');
    const backgroundMusicPath = 'path/to/music.mp3';

    await mixAudioWithBackground(narrationBuffer, backgroundMusicPath);

    // Verify FFmpeg filter setup
    expect(mockComplexFilter).toHaveBeenCalled();
    const filterString = mockComplexFilter.mock.calls[0][0] as string;

    // Default volume parameters should be used
    expect(filterString).toContain('volume=1'); // Narration volume defaults to 1.0
    expect(filterString).toContain('volume=0.1'); // Background volume defaults to 0.1
    expect(filterString).toContain('normalize=0'); // Normalize set to 0 to prevent volume halving
    expect(filterString).toContain('amix=inputs=2');
  });

  test('should apply custom narrationVolume and backgroundVolume correctly', async () => {
    const narrationBuffer = Buffer.from('mock-narration');
    const backgroundMusicPath = 'path/to/music.mp3';

    await mixAudioWithBackground(narrationBuffer, backgroundMusicPath, {
      narrationVolume: 1.5,
      backgroundVolume: 0.1,
    });

    const filterString = mockComplexFilter.mock.calls[0][0] as string;

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

    const filterString = mockComplexFilter.mock.calls[0][0] as string;
    const filterParts = filterString.split(';');
    const narrationFilter = filterParts[0];
    const backgroundFilter = filterParts[1];

    expect(narrationFilter).not.toContain('afade');
    expect(backgroundFilter).toContain('afade=t=in:st=0:d=2');
    expect(backgroundFilter).toContain('afade=t=out:st=98:d=2');
    expect(filterString).toContain('amix=inputs=2:duration=first');
  });
});
