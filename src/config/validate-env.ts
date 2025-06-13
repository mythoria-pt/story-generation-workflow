import { validateEnvironment } from './environment.js';

// Validate environment on startup
if (import.meta.url === `file://${process.argv[1]}`) {
  validateEnvironment();
}
