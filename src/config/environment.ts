import { z } from 'zod';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';

// Load environment variables based on NODE_ENV
const nodeEnv = process.env.NODE_ENV || 'development';

// Load appropriate environment files only if they exist
if (nodeEnv === 'production') {
  // In production (Cloud Run), environment variables are set via deployment config
  // Only load .env.production if it exists locally
  if (fs.existsSync('.env.production')) {
    config({ path: '.env.production' });
  }
} else if (nodeEnv === 'development') {
  if (fs.existsSync('.env.local')) {
    config({ path: '.env.local' });
  }
  if (fs.existsSync('.env')) {
    config({ path: '.env' });
  }
} else {
  if (fs.existsSync(`.env.${nodeEnv}`)) {
    config({ path: `.env.${nodeEnv}` });
  }
  if (fs.existsSync('.env')) {
    config({ path: '.env' });
  }
}

// Environment schema based on .env.schema.json
const envSchema = z.object({
  // Added 'test' to support Jest and other test runners without failing validation
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']),
  PORT: z.string().transform(Number).default('8080'),
  DB_HOST: z.string(),
  DB_PORT: z.string().transform(Number),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string(),
  GOOGLE_CLOUD_PROJECT_ID: z.string(),
  GOOGLE_CLOUD_REGION: z.string(),
  GOOGLE_GENAI_CLOUD_REGION: z.string().optional().default('global'),
  STORAGE_BUCKET_NAME: z.string(),
  IMAGE_GENERATION_MODEL: z.string().optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).optional().default('info'), // AI Provider Configuration
  TEXT_PROVIDER: z.enum(['openai', 'google-genai']).optional().default('google-genai'),
  IMAGE_PROVIDER: z.enum(['openai', 'google-genai']).optional().default('google-genai'),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_MODEL: z.string().optional().default('gpt-5.2'),
  OPENAI_TEXT_MODEL: z.string().optional(), // legacy alias for base model
  OPENAI_IMAGE_TOOL_MODEL: z.string().optional().default('gpt-image-1.5'),
  OPENAI_IMAGE_QUALITY: z.enum(['low', 'standard', 'high']).optional().default('low'),

  // Temp directory configuration
  TEMP_DIR: z.string().optional(),
  GHOSTSCRIPT_BINARY: z.string().optional(),

  // Google GenAI Configuration
  GOOGLE_GENAI_API_KEY: z.string().optional(),
  GOOGLE_GENAI_MODEL: z.string().optional().default('gemini-2.5-flash'),
  GOOGLE_GENAI_IMAGE_MODEL: z.string().optional().default('gemini-2.5-flash-image-preview'),

  // TTS Configuration
  // Supports OpenAI and Google Gemini TTS providers
  TTS_PROVIDER: z.enum(['openai', 'google-genai']).optional().default('google-genai'),
  TTS_MODEL: z.string().optional().default('gemini-2.5-pro-preview-tts'),
  TTS_VOICE: z.string().optional().default('Charon'),
  TTS_SPEED: z.string().optional().default('1'),
  TTS_LANGUAGE: z.string().optional().default('en-US'),

  // Background Music Configuration
  // Controls whether background music is mixed with narration audio
  BACKGROUND_MUSIC_ENABLED: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  // Volume of background music relative to narration (0.0 to 1.0)
  BACKGROUND_MUSIC_VOLUME: z
    .string()
    .optional()
    .default('0.2')
    .transform((v) => {
      const n = v ? parseFloat(v) : 0.2;
      return Number.isNaN(n) ? 0.2 : Math.max(0, Math.min(1, n));
    }),
  // Fade in duration in seconds for background music
  BACKGROUND_MUSIC_FADE_IN: z
    .string()
    .optional()
    .default('1.5')
    .transform((v) => {
      const n = v ? parseFloat(v) : 1.5;
      return Number.isNaN(n) ? 1.5 : Math.max(0, n);
    }),
  // Fade out duration in seconds for background music
  BACKGROUND_MUSIC_FADE_OUT: z
    .string()
    .optional()
    .default('1.5')
    .transform((v) => {
      const n = v ? parseFloat(v) : 1.5;
      return Number.isNaN(n) ? 1.5 : Math.max(0, n);
    }),

  // Notification Engine
  NOTIFICATION_ENGINE_URL: z.string().optional(),
  NOTIFICATION_ENGINE_API_KEY: z.string().optional(),

  // Webapp webhook for persisting async text edits
  WEBAPP_WEBHOOK_URL: z.string().url().optional(),
  WEBAPP_WEBHOOK_SECRET: z.string().optional(),

  // Image Size Configuration
  IMAGE_DEFAULT_WIDTH: z.string().transform(Number).optional().default('1024'),
  IMAGE_DEFAULT_HEIGHT: z.string().transform(Number).optional().default('1536'),
  IMAGE_CHAPTER_WIDTH: z.string().transform(Number).optional().default('1024'),
  IMAGE_CHAPTER_HEIGHT: z.string().transform(Number).optional().default('1536'),
  IMAGE_COVER_WIDTH: z.string().transform(Number).optional().default('1024'),
  IMAGE_COVER_HEIGHT: z.string().transform(Number).optional().default('1536'),
  // Story generation contextual memory cap (characters). Controls how much outline + summaries + last chapters we include.
  STORY_CONTEXT_MAX_CHARS: z
    .string()
    .optional()
    .transform((v) => {
      const n = v ? parseInt(v, 10) : 12000;
      return Number.isNaN(n) ? 12000 : n;
    }),
});

export type Environment = z.infer<typeof envSchema>;

let cachedEnv: Environment | null = null;

export function getEnvironment(): Environment {
  if (cachedEnv) {
    return cachedEnv;
  }

  try {
    // Ensure PORT is set (Cloud Run sets it automatically, but provide a fallback)
    const envVars = {
      ...process.env,
      PORT: process.env.PORT || '8080',
      // Ensure backward compatibility with GOOGLE_CLOUD_REGION
      GOOGLE_CLOUD_REGION: process.env.GOOGLE_CLOUD_REGION,
      GOOGLE_GENAI_CLOUD_REGION: process.env.GOOGLE_GENAI_CLOUD_REGION || 'global',
    };

    cachedEnv = envSchema.parse(envVars);
    return cachedEnv;
  } catch (error) {
    console.error('Environment validation failed:', error);
    throw error;
  }
}

export function validateEnvironment(): void {
  const schemaPath = path.join(process.cwd(), '.env.schema.json');

  if (fs.existsSync(schemaPath)) {
    console.log('✅ Environment schema found');
  }
  try {
    const env = getEnvironment();
    console.log('✅ Environment variables validated successfully');
    console.log(`📍 Running in ${env.NODE_ENV} mode`);
    console.log(`🔌 Server will start on port ${env.PORT}`);
    console.log(`🏢 Google Cloud Project: ${env.GOOGLE_CLOUD_PROJECT_ID}`);
    console.log(`📦 Storage Bucket: ${env.STORAGE_BUCKET_NAME}`);
    console.log(`🎨 Image Provider: ${env.IMAGE_PROVIDER}`);
    if (env.IMAGE_PROVIDER === 'openai') {
      const baseModel = env.OPENAI_BASE_MODEL || env.OPENAI_TEXT_MODEL || 'gpt-5.2';
      const imageToolModel = env.OPENAI_IMAGE_TOOL_MODEL || 'gpt-image-1.5';
      console.log(`🤖 OpenAI Base Model: ${baseModel}`);
      console.log(`🖼️ OpenAI Image Tool Model: ${imageToolModel}`);
    } else if (env.IMAGE_PROVIDER === 'google-genai') {
      console.log(`🖼️ Google Imagen Model: ${env.GOOGLE_GENAI_IMAGE_MODEL}`);
    }
  } catch (error) {
    console.error('❌ Environment validation failed');
    throw error;
  }
}

// Export individual config objects for easier imports
export const databaseConfig = {
  get: () => {
    const env = getEnvironment();
    return {
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      ssl: false, // Always false as per requirement
    };
  },
};

export const googleCloudConfig = {
  get: () => {
    const env = getEnvironment();
    return {
      projectId: env.GOOGLE_CLOUD_PROJECT_ID,
      region: env.GOOGLE_CLOUD_REGION,
      storageBucket: env.STORAGE_BUCKET_NAME,
      workflows: {
        location: env.GOOGLE_CLOUD_REGION,
      },
    };
  },
};
