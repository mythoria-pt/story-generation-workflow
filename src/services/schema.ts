/**
 * Schema Loading Utility
 * Loads JSON schemas for structured AI outputs
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { logger } from '@/config/logger.js';

export class SchemaService {
  private static schemaCache = new Map<string, object>();

  /**
   * Load a JSON schema by name
   */
  static async loadSchema(schemaName: string): Promise<object> {
    try {    // Check cache first
    if (this.schemaCache.has(schemaName)) {
      const cachedSchema = this.schemaCache.get(schemaName);
      if (cachedSchema) {
        return cachedSchema;
      }
    }

      // Load schema from file
      const schemaPath = join(process.cwd(), 'src', 'prompts', 'schemas', `${schemaName}.json`);
      const schemaContent = await readFile(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);

      // Cache the schema
      this.schemaCache.set(schemaName, schema);

      logger.debug('Schema loaded successfully', {
        schemaName,
        schemaPath
      });

      return schema;
    } catch (error) {
      logger.error('Failed to load schema', {
        error: error instanceof Error ? error.message : String(error),
        schemaName
      });
      throw new Error(`Failed to load schema: ${schemaName}`);
    }
  }

  /**
   * Clear schema cache
   */
  static clearCache(): void {
    this.schemaCache.clear();
    logger.info('Schema cache cleared');
  }
}
