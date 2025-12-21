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
  { name: 'PORT', required: true, scopes: ['dev', 'runtime'], default: '8080', note: 'Cloud Run injects PORT in prod.' },

  // Database
  { name: 'DB_HOST', required: true, scopes: ['dev', 'runtime', 'prod'], secret: true, source: 'secret-manager' },
  { name: 'DB_PORT', required: true, scopes: ['dev', 'runtime', 'prod'], default: '5432', source: 'substitution' },
  { name: 'DB_USER', required: true, scopes: ['dev', 'runtime', 'prod'], secret: true, source: 'secret-manager' },
  { name: 'DB_PASSWORD', required: true, scopes: ['dev', 'runtime', 'prod'], secret: true, source: 'secret-manager' },
  { name: 'DB_NAME', required: true, scopes: ['dev', 'runtime', 'prod'], default: 'story_generation_workflow', source: 'substitution' },
  { name: 'DB_SSL', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'false', note: 'Enable for public Postgres endpoints.' },

  // Google Cloud
  { name: 'GOOGLE_CLOUD_PROJECT_ID', required: true, scopes: ['dev', 'runtime', 'prod'], source: 'substitution' },
  { name: 'GOOGLE_CLOUD_REGION', required: true, scopes: ['dev', 'runtime', 'prod'], source: 'substitution' },
  { name: 'STORAGE_BUCKET_NAME', required: true, scopes: ['dev', 'runtime', 'prod'], source: 'substitution' },
  { name: 'WORKFLOWS_LOCATION', required: true, scopes: ['dev', 'runtime', 'prod'], source: 'substitution' },

  // Vertex / AI
  { name: 'VERTEX_AI_MODEL_ID', required: true, scopes: ['dev', 'runtime', 'prod'], source: 'substitution' },
  { name: 'VERTEX_AI_LOCATION', required: false, scopes: ['dev', 'runtime', 'prod'], source: 'substitution', note: 'Defaults to GOOGLE_CLOUD_REGION if unset.' },
  { name: 'IMAGE_GENERATION_MODEL', required: false, scopes: ['dev', 'runtime', 'prod'], note: 'Optional override for image generation provider/model.' },

  // Logging
  { name: 'LOG_LEVEL', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'info' },

  // OpenAI image retries
  { name: 'OPENAI_IMAGE_MAX_RETRIES', required: false, scopes: ['dev', 'runtime', 'prod'], default: '2' },
  { name: 'OPENAI_IMAGE_EDIT_MAX_RETRIES', required: false, scopes: ['dev', 'runtime', 'prod'], default: '2' },
  { name: 'OPENAI_IMAGE_RETRY_DELAY_MS', required: false, scopes: ['dev', 'runtime', 'prod'], default: '1500' },
  { name: 'OPENAI_IMAGE_PREFER_BASE64', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'true' },

  // TTS
  { name: 'TTS_PROVIDER', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'openai' },
  { name: 'TTS_MODEL', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'gpt-4o-mini-tts' },
  { name: 'TTS_VOICE', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'coral' },
  { name: 'TTS_SPEED', required: false, scopes: ['dev', 'runtime', 'prod'], default: '1.0' },
  { name: 'TTS_LANGUAGE', required: false, scopes: ['dev', 'runtime', 'prod'], default: 'en-US' },

  // Webhooks
  { name: 'WEBAPP_WEBHOOK_URL', required: false, scopes: ['dev', 'runtime', 'prod'], note: 'Callback to webapp when jobs complete.' },
  { name: 'WEBAPP_WEBHOOK_SECRET', required: false, scopes: ['dev', 'runtime', 'prod'], secret: true },
];

export function manifestByName() {
  const map: Record<string, EnvVarDescriptor> = {};
  for (const v of envManifest) map[v.name] = v;
  return map;
}
