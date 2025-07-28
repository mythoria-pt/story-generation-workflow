import { validateEnvironment } from './environment';

// Validate environment on startup
if (require.main === module) {
  validateEnvironment();
}
