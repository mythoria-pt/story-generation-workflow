import { z } from 'zod';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';

// Load environment variables based on NODE_ENV
const nodeEnv = process.env.NODE_ENV || 'development';

// Load appropriate environment files
if (nodeEnv === 'production') {
  config({ path: '.env.production' });
} else if (nodeEnv === 'development') {
  config({ path: '.env.local' });
  config({ path: '.env' });
} else {
  config({ path: `.env.${nodeEnv}` });
  config({ path: '.env' });
}

// Environment schema based on .env.schema.json
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']),
  PORT: z.string().transform(Number).default('8080'),
  DB_HOST: z.string(),
  DB_PORT: z.string().transform(Number),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string(),
  DB_SSL: z.string().transform(val => val === 'true').optional(),
  GOOGLE_CLOUD_PROJECT_ID: z.string(),
  GOOGLE_CLOUD_REGION: z.string(),
  GOOGLE_CLOUD_LOCATION: z.string().optional(), // For backward compatibility
  STORAGE_BUCKET_NAME: z.string(),  VERTEX_AI_MODEL_ID: z.string(),
  VERTEX_AI_OUTLINE_MODEL: z.string().optional(), // Specific model for outline generation
  VERTEX_AI_LOCATION: z.string().optional(),
  WORKFLOWS_LOCATION: z.string(),
  IMAGE_GENERATION_MODEL: z.string().optional(),
  AUDIO_GENERATION_MODEL: z.string().optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).optional().default('info'),  // AI Provider Configuration
  TEXT_PROVIDER: z.enum(['vertex', 'openai']).optional().default('vertex'),
  IMAGE_PROVIDER: z.enum(['vertex', 'openai']).optional().default('vertex'),  OPENAI_API_KEY: z.string().optional(),
  OPENAI_IMAGE_MODEL: z.string().optional().default('dall-e-3'),
  OPENAI_IMAGE_QUALITY: z.enum(['low', 'standard', 'high']).optional().default('low'),
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
      // Ensure backward compatibility with GOOGLE_CLOUD_LOCATION
      GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION || process.env.GOOGLE_CLOUD_REGION
    };
    
    cachedEnv = envSchema.parse(envVars);
    return cachedEnv;
  } catch (error) {
    console.error('Environment validation failed:', error);
    process.exit(1);
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
      console.log(`🤖 OpenAI Image Model: ${env.OPENAI_IMAGE_MODEL}`);
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
      ssl: env.DB_SSL,
    };
  },
};

export const googleCloudConfig = {
  get: () => {
    const env = getEnvironment();
    return {
      projectId: env.GOOGLE_CLOUD_PROJECT_ID,
      region: env.GOOGLE_CLOUD_REGION,
      storageBucket: env.STORAGE_BUCKET_NAME,      vertexAi: {
        modelId: env.VERTEX_AI_MODEL_ID,
        outlineModel: env.VERTEX_AI_OUTLINE_MODEL || env.VERTEX_AI_MODEL_ID, // Use specific model for outlines or fall back to default
        location: env.VERTEX_AI_LOCATION || env.GOOGLE_CLOUD_REGION,
      },
      workflows: {
        location: env.WORKFLOWS_LOCATION,
      },
    };
  },
};
