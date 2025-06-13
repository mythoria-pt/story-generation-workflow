import { databaseConfig } from './environment.js';

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean | object;
}

export function getDatabaseConfig(): DatabaseConfig {
  const config = databaseConfig.get();
  return {
    ...config,
    ssl: config.ssl ?? false
  };
}
