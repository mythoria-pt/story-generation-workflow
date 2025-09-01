import { jest } from "@jest/globals";

// Mock the environment module
jest.mock("@/config/environment.js", () => ({
  getEnvironment: jest.fn().mockReturnValue({
    NODE_ENV: "test",
    PORT: 8080,
    DB_HOST: "localhost",
    DB_PORT: 5432,
    DB_USER: "test_user",
    DB_PASSWORD: "test_password",
    DB_NAME: "test_db",
    GOOGLE_CLOUD_PROJECT_ID: "test-project",
    GOOGLE_CLOUD_REGION: "us-central1",
    STORAGE_BUCKET_NAME: "test-bucket",
    LOG_LEVEL: "info",
    TEXT_PROVIDER: "google-genai",
    IMAGE_PROVIDER: "google-genai",
    GOOGLE_GENAI_API_KEY: "test-key",
    GOOGLE_GENAI_MODEL: "gemini-2.5-flash",
    GOOGLE_GENAI_IMAGE_MODEL: "imagen-4.0-ultra-generate-001",
    OPENAI_API_KEY: "test-key",
    TTS_PROVIDER: "openai",
    TTS_MODEL: "gpt-4o-mini-tts",
    TTS_VOICE: "nova",
    TTS_SPEED: "0.9",
    TTS_LANGUAGE: "en-US",
  }),
  validateEnvironment: jest.fn(),
}));
