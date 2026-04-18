import { getEnvironment } from '@/config/environment.js';
import { logger } from '@/config/logger.js';

export interface MythoriaAdminManager {
  managerId: string;
  name: string;
  email: string;
  mobilePhone?: string | null;
  role?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface ManagersResponse {
  data: MythoriaAdminManager[];
  count: number;
}

export class MythoriaAdminClient {
  private readonly baseUrl: string | null;
  private readonly apiKey: string | null;

  constructor() {
    const env = getEnvironment();
    this.baseUrl = env.MYTHORIA_ADMIN_URL ? env.MYTHORIA_ADMIN_URL.replace(/\/$/, '') : null;
    this.apiKey = env.MYTHORIA_ADMIN_API_KEY ?? null;
  }

  async getManagers(): Promise<MythoriaAdminManager[]> {
    if (!this.baseUrl || !this.apiKey) {
      logger.warn('Mythoria admin client not configured; skipping manager fetch', {
        hasBaseUrl: !!this.baseUrl,
        hasApiKey: !!this.apiKey,
      });
      return [];
    }

    const url = `${this.baseUrl}/api/admin/managers`;
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'x-api-key': this.apiKey,
      Accept: 'application/json',
    };

    try {
      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) {
        const body = await response.text();
        logger.error('Failed to fetch Mythoria admin managers', {
          status: response.status,
          statusText: response.statusText,
          body,
        });
        return [];
      }

      const payload = (await response.json()) as ManagersResponse;
      if (!payload || !Array.isArray(payload.data)) {
        logger.error('Unexpected Mythoria admin managers payload', {
          payloadType: typeof payload,
        });
        return [];
      }

      return payload.data.filter(
        (manager): manager is MythoriaAdminManager =>
          !!manager && typeof manager.email === 'string' && manager.email.length > 0,
      );
    } catch (error) {
      logger.error('Error while fetching Mythoria admin managers', {
        error: error instanceof Error ? error.message : String(error),
        url,
      });
      return [];
    }
  }
}
