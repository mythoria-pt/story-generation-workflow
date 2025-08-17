import { Request, Response, NextFunction } from 'express';

const EXPECTED_KEY = process.env.STORY_GENERATION_WORKFLOW_API_KEY || '';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  // Allow unauthenticated access if no key configured (development fallback)
  if (!EXPECTED_KEY) return next();

  const headerKey = req.header('x-api-key');
  if (!headerKey || headerKey !== EXPECTED_KEY) {
  res.status(401).json({ success: false, error: 'Unauthorized' });
  return;
  }
  next();
}

export default apiKeyAuth;
