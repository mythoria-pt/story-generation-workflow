// Canonical environment variable manifest for Story Generation Workflow
// Mirrors .env.schema.json; keep scopes aligned with backend expectations.
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
  { name: 'WORKFLOWS_DB', required: true, scopes: ['dev', 'runtime', 'prod'], default: 'workflows_db' },

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

  // Logging
  { name: 'LOG_LEVEL', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'info' },
  { name: 'DEBUG_AI_FULL_PROMPTS', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'false' },
  { name: 'DEBUG_AI_FULL_RESPONSES', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'false' },

  // TTS
  { name: 'TTS_PROVIDER', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'google-genai' },
  {
    name: 'TTS_MODEL',
    required: false,
    scopes: ['dev', 'runtime', 'prod'],
    default: 'gemini-2.5-pro-preview-tts',
  },
  { name: 'TTS_VOICE', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'Charon' },
  { name: 'TTS_SPEED', required: false, scopes: ['dev', 'runtime', 'prod'], default: '1' },
  { name: 'TTS_LANGUAGE', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'en-US' },
  { name: 'BACKGROUND_MUSIC_VOLUME', required: false, scopes: ['dev', 'runtime', 'prod'], default: '0.2' },

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
