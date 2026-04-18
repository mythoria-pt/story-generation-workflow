import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

describe('MythoriaAdminClient', () => {
  const originalEnv = { ...process.env };
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      PORT: '8080',
      DB_HOST: 'localhost',
      DB_PORT: '5432',
      DB_USER: 'postgres',
      DB_PASSWORD: 'postgres',
      DB_NAME: 'mythoria',
      GOOGLE_CLOUD_PROJECT_ID: 'test-project',
      GOOGLE_CLOUD_REGION: 'europe-west9',
      STORAGE_BUCKET_NAME: 'test-bucket',
      MYTHORIA_ADMIN_URL: 'https://admin.example.com',
      MYTHORIA_ADMIN_API_KEY: 'secret-key',
    };
    global.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('fetches managers with both bearer and x-api-key headers', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            managerId: 'manager-1',
            name: 'Admin One',
            email: 'admin1@example.com',
          },
        ],
        count: 1,
      }),
    });

    const { MythoriaAdminClient } = await import('@/services/mythoria-admin-client.js');
    const client = new MythoriaAdminClient();
    const managers = await client.getManagers();

    expect(managers).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://admin.example.com/api/admin/managers',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-key',
          'x-api-key': 'secret-key',
        }),
      }),
    );
  });

  it('returns an empty list when the admin API call fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async () => 'boom',
    });

    const { MythoriaAdminClient } = await import('@/services/mythoria-admin-client.js');
    const client = new MythoriaAdminClient();
    const managers = await client.getManagers();

    expect(managers).toEqual([]);
  });
});
