const configuredBinary = process.env.FFMPEG_BINARY?.trim();

export const FFMPEG_BINARY = configuredBinary || 'ffmpeg';
