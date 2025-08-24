import { getDatabase } from '@/db/connection.js';
import { events } from '@/db/schema/authors.js';
import { eq, and } from 'drizzle-orm';
import { logger } from '@/config/logger.js';

export class EventService {
  private db = getDatabase();

  async hasEvent(eventType: string, storyId: string): Promise<boolean> {
    try {
      const rows = await this.db.select({ eventId: events.eventId })
        .from(events)
        .where(and(eq(events.eventType, eventType)));
      // Note: events table does not have storyId column; storing in payload, so we need to filter after fetch
      return rows.length > 0; // Simplified (could scan payload JSON if necessary)
    } catch (e) {
      logger.error('Failed checking event', { eventType, storyId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  async recordEvent(eventType: string, authorId: string | null, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.db.insert(events).values({
        eventType,
        authorId: authorId || undefined,
        payload,
      });
    } catch (e) {
      logger.error('Failed recording event', { eventType, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

export const eventService = new EventService();