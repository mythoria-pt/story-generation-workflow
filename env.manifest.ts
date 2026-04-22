// Canonical environment variable manifest for Story Generation Workflow
// Align with src/config/environment.ts (Zod); .env.schema.json is a legacy subset.
export type EnvScope = 'dev' | 'prod' | 'runtime' | 'build' | 'public';
export interface EnvVarDescriptor {
  name: string;
  required: boolean;
  scopes: EnvScope[];
  secret?: boolean;
  default?: string;
  note?: string;
  deprecated?: boolean;
  source?: 'secret-manager' | 'substitution' | 'inline';
}

export const envManifest: EnvVarDescriptor[] = [
  { name: 'NODE_ENV', required: true, scopes: ['dev', 'runtime', 'prod'], default: 'development' },
  {
    name: 'PORT',
    required: true,
    scopes: ['dev', 'runtime'],
    default: '8080',
    note: 'Cloud Run injects PORT in prod.',
  },

  // Database
  {
    name: 'DB_HOST',
    required: true,
    scopes: ['dev', 'runtime', 'prod'],
    secret: true,
    source: 'secret-manager',
  },
  {
    name: 'DB_PORT',
    required: true,
    scopes: ['dev', 'runtime', 'prod'],
    default: '5432',
    source: 'substitution',
  },
  {
    name: 'DB_USER',
    required: true,
    scopes: ['dev', 'runtime', 'prod'],
    secret: true,
    source: 'secret-manager',
  },
  {
    name: 'DB_PASSWORD',
    required: true,
    scopes: ['dev', 'runtime', 'prod'],
    secret: true,
    source: 'secret-manager',
  },
  {
    name: 'DB_NAME',
    required: true,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'mythoria_db',
    source: 'substitution',
  },
  {
    name: 'WORKFLOWS_DB',
    required: true,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'workflows_db',
  },

  // Google Cloud
  {
    name: 'GOOGLE_CLOUD_PROJECT_ID',
    required: true,
    scopes: ['dev', 'runtime', 'prod'],
    source: 'substitution',
  },
  {
    name: 'GOOGLE_CLOUD_REGION',
    required: true,
    scopes: ['dev', 'runtime', 'prod'],
    source: 'substitution',
  },
  {
    name: 'STORAGE_BUCKET_NAME',
    required: true,
    scopes: ['dev', 'runtime', 'prod'],
    source: 'substitution',
  },
  {
    name: 'GOOGLE_GENAI_CLOUD_REGION',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'global',
    source: 'substitution',
    note: 'GenAI client location (e.g. global, us-central1, europe-west9).',
  },
  // AI providers
  {
    name: 'TEXT_PROVIDER',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'google-genai',
    source: 'inline',
  },
  {
    name: 'IMAGE_PROVIDER',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'google-genai',
    source: 'inline',
  },
  {
    name: 'GOOGLE_GENAI_API_KEY',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    secret: true,
    source: 'secret-manager',
  },
  {
    name: 'GOOGLE_GENAI_MODEL',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'gemini-2.5-flash',
    source: 'substitution',
  },
  {
    name: 'GOOGLE_GENAI_IMAGE_MODEL',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'gemini-3.1-flash-image-preview',
    source: 'substitution',
  },
  {
    name: 'GOOGLE_GENAI_USE_VERTEX',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'false',
    source: 'inline',
    note: 'If true, use Vertex AI instead of API key (advanced).',
  },
  {
    name: 'GOOGLE_GENAI_FORCE_REST',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'false',
    source: 'inline',
    note: 'Debug: force REST transport (see debug-image routes).',
  },
  {
    name: 'GOOGLE_GENAI_DISABLE_IMAGEN_MAPPING',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'false',
    source: 'inline',
    note: 'Debug: disable Imagen mapping in image pipeline.',
  },
  {
    name: 'OPENAI_API_KEY',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    secret: true,
    source: 'secret-manager',
  },
  {
    name: 'OPENAI_BASE_MODEL',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'gpt-5.2',
    source: 'substitution',
  },
  {
    name: 'OPENAI_TEXT_MODEL',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'gpt-5.2',
    deprecated: true,
    note: 'Legacy alias for OPENAI_BASE_MODEL.',
  },
  {
    name: 'OPENAI_MODEL',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    deprecated: true,
    note: 'Legacy alias read only in src/ai/gateway.ts; prefer OPENAI_BASE_MODEL.',
  },
  {
    name: 'OPENAI_IMAGE_TOOL_MODEL',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'gpt-image-1.5',
    source: 'substitution',
  },
  {
    name: 'OPENAI_IMAGE_QUALITY',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'low',
    source: 'substitution',
  },
  {
    name: 'IMAGE_GENERATION_MODEL',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    source: 'substitution',
    note: 'Optional passthrough model id for image generation.',
  },
  {
    name: 'IMAGE_DEFAULT_WIDTH',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: '1024',
    source: 'substitution',
  },
  {
    name: 'IMAGE_DEFAULT_HEIGHT',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: '1536',
    source: 'substitution',
  },
  {
    name: 'IMAGE_CHAPTER_WIDTH',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: '1024',
    source: 'substitution',
  },
  {
    name: 'IMAGE_CHAPTER_HEIGHT',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: '1536',
    source: 'substitution',
  },
  {
    name: 'IMAGE_COVER_WIDTH',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: '1024',
    source: 'substitution',
  },
  {
    name: 'IMAGE_COVER_HEIGHT',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: '1536',
    source: 'substitution',
  },
  {
    name: 'STORY_CONTEXT_MAX_CHARS',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: '12000',
    source: 'substitution',
    note: 'Max characters of outline/summaries/chapters in story context.',
  },
  {
    name: 'TEMP_DIR',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    source: 'substitution',
    note: 'Optional temp directory for print/PDF pipeline.',
  },
  {
    name: 'GHOSTSCRIPT_BINARY',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    source: 'substitution',
    note: 'Path to Ghostscript binary (CMYK/print); optional on Unix.',
  },

  // Logging
  { name: 'LOG_LEVEL', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'info' },
  {
    name: 'DEBUG_AI_FULL_PROMPTS',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'false',
  },
  {
    name: 'DEBUG_AI_FULL_RESPONSES',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'false',
  },

  // TTS
  {
    name: 'TTS_PROVIDER',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'google-genai',
  },
  {
    name: 'TTS_MODEL',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'gemini-2.5-pro-preview-tts',
  },
  { name: 'TTS_VOICE', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'Charon' },
  { name: 'TTS_SPEED', required: false, scopes: ['dev', 'runtime', 'prod'], default: '1' },
  { name: 'TTS_LANGUAGE', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'en-US' },
  {
    name: 'BACKGROUND_MUSIC_ENABLED',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'true',
    source: 'inline',
  },
  {
    name: 'BACKGROUND_MUSIC_VOLUME',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: '0.2',
  },
  {
    name: 'BACKGROUND_MUSIC_FADE_IN',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: '1.5',
    source: 'inline',
    note: 'Fade-in seconds for background music.',
  },
  {
    name: 'BACKGROUND_MUSIC_FADE_OUT',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: '1.5',
    source: 'inline',
    note: 'Fade-out seconds for background music.',
  },

  // Auth / integrations
  {
    name: 'STORY_GENERATION_WORKFLOW_API_KEY',
    required: true,
    scopes: ['dev', 'runtime', 'prod'],
    secret: true,
    source: 'secret-manager',
  },
  {
    name: 'NOTIFICATION_ENGINE_URL',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    source: 'substitution',
  },
  {
    name: 'NOTIFICATION_ENGINE_API_KEY',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    secret: true,
    source: 'secret-manager',
  },
  {
    name: 'MYTHORIA_ADMIN_URL',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    source: 'substitution',
    note: 'Mythoria Admin API base URL.',
  },
  {
    name: 'MYTHORIA_ADMIN_API_KEY',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    secret: true,
    source: 'secret-manager',
  },

  // Webhooks
  {
    name: 'WEBAPP_WEBHOOK_URL',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    source: 'substitution',
    note: 'Callback to webapp when jobs complete.',
  },
  {
    name: 'WEBAPP_WEBHOOK_SECRET',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    secret: true,
    source: 'secret-manager',
  },
];

export function manifestByName() {
  const map: Record<string, EnvVarDescriptor> = {};
  for (const v of envManifest) map[v.name] = v;
  return map;
}
