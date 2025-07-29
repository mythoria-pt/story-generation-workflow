import { join } from 'path';
import { existsSync } from 'fs';

/**
 * Gets the correct base path for static resources (prompts, messages)
 * In development: uses src/ folder
 * In production: uses dist/ folder (after build with copyfiles -u 1 which strips the src/ prefix)
 */
export function getResourceBasePath(): string {
  const cwd = process.cwd();
  
  // Check if we're running from the dist folder (production)
  // Multiple ways to detect this:
  // 1. Check if src folder exists (development has it, production doesn't)
  // 2. Check if we're running from dist/index.js
  // 3. Check NODE_ENV
  // 4. Check if dist/prompts exists (production build result)
  
  const srcExists = existsSync(join(cwd, 'src'));
  const distPromptsExists = existsSync(join(cwd, 'dist', 'prompts'));
  const isRunningFromDist = __filename.includes('dist/') || __filename.includes('dist\\');
  const isProduction = process.env.NODE_ENV === 'production';
  
  // If we're in production or running from dist, or if src doesn't exist but dist/prompts does
  if (isProduction || isRunningFromDist || (!srcExists && distPromptsExists)) {
    // In production, static files are copied to dist/ (copyfiles -u 1 strips src/ prefix)
    return join(cwd, 'dist');
  } else {
    // In development, use the source folder directly
    return join(cwd, 'src');
  }
}

/**
 * Gets the path to the prompts directory
 */
export function getPromptsPath(): string {
  return join(getResourceBasePath(), 'prompts');
}

/**
 * Gets the path to the messages directory
 */
export function getMessagesPath(): string {
  return join(getResourceBasePath(), 'messages');
}

/**
 * Gets the path to the templates directory
 */
export function getTemplatesPath(): string {
  return join(getResourceBasePath(), 'templates');
}


