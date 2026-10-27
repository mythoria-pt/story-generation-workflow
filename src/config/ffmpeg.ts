const configuredBinary = process.env.FFMPEG_BINARY?.trim();

export const FFMPEG_BINARY = configuredBinary || 'ffmpeg';

const configuredProbeBinary = process.env.FFPROBE_BINARY?.trim();

export const FFPROBE_BINARY = configuredProbeBinary || 'ffprobe';
