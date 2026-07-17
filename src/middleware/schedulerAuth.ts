import type { NextFunction, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';

const authClient = new OAuth2Client();

export async function schedulerAuth(req: Request, res: Response, next: NextFunction) {
  const expectedEmail = process.env.ANALYTICS_SCHEDULER_SERVICE_ACCOUNT?.trim();
  const authorization = req.header('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!expectedEmail || !token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const forwardedProto = req.header('x-forwarded-proto') || req.protocol;
    const audience = `${forwardedProto}://${req.get('host')}`;
    const ticket = await authClient.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    if (payload?.email_verified !== true || payload.email !== expectedEmail) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
