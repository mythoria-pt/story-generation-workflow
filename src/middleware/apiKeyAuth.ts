import { Request, Response, NextFunction } from 'express';

const EXPECTED_KEY = process.env.STORY_GENERATION_WORKFLOW_API_KEY || '';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  // Require API key in all environments; no dev fallback
  const headerKey = req.header('x-api-key');
  const expectedTrimmed = (EXPECTED_KEY || '').trim();
  const headerTrimmed = (headerKey || '').trim();
  if (!expectedTrimmed || !headerTrimmed || headerTrimmed !== expectedTrimmed) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  next();
}

export default apiKeyAuth;
