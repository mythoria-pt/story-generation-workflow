import { beforeEach, expect, it, jest } from '@jest/globals';

const getCheckpoint = jest.fn<(_: unknown, key: string) => Promise<unknown>>();
const getMetadata = jest.fn<() => Promise<unknown[]>>();
const getSignedUrl = jest.fn<(options: { expires: number }) => Promise<string[]>>();
const file = jest.fn(() => ({ getMetadata, getSignedUrl }));

jest.mock('@/services/premium-book-storage.js', () => ({
  getPremiumBucket: async () => ({ file }),
  readPremiumCheckpoint: getCheckpoint,
}));

import { getVerifiedPremiumPrintPackage } from '@/services/premium-self-print.js';

const storyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const revision = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ownerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const prefix = `${storyId}/premium/revisions/${revision}/self-print/${runId}`;
const sha256 = 'c'.repeat(64);
const source = {
  ownerId,
  revision,
  generateCMYK: false,
  manifest: {
    key: `${storyId}/premium/revisions/${revision}/manifest.json`,
    generation: '154',
    bytes: 100,
    sha256,
  },
};
const pdf = (part: string) => ({
  key: `${prefix}/${sha256}/${part}.pdf`,
  generation: '150',
  bytes: 200,
  sha256,
});
const pack = {
  interior: pdf('interior'),
  cover: pdf('cover'),
  interiorCmyk: null,
  coverCmyk: null,
};

beforeEach(() => {
  jest.resetAllMocks();
  file.mockImplementation(() => ({ getMetadata, getSignedUrl }));
  getCheckpoint.mockImplementation(async (_, key) =>
    key === `${prefix}/edition.json` ? source : pack,
  );
  getMetadata.mockResolvedValue([
    { contentType: 'application/pdf', size: '200', generation: '150' },
  ]);
  getSignedUrl.mockResolvedValue(['signed-url']);
});

it('verifies the exact PDF generation and its size before signing a five-minute attachment', async () => {
  const result = await getVerifiedPremiumPrintPackage(storyId, runId, source, 'self-print');
  expect(result?.parts).toEqual(['interior', 'cover']);
  const now = Date.now();
  await expect(result?.sign('interior')).resolves.toBe('signed-url');
  expect(result?.sign('interiorCmyk')).toBeNull();
  expect(file).toHaveBeenCalledWith(pdf('interior').key, { generation: 150 });
  expect(getSignedUrl).toHaveBeenCalledTimes(1);
  expect(getSignedUrl).toHaveBeenCalledWith(
    expect.objectContaining({ version: 'v4', action: 'read', promptSaveAs: 'interior.pdf' }),
  );
  const options = getSignedUrl.mock.calls[0]?.[0];
  expect(options?.expires).toBeGreaterThanOrEqual(now + 300_000);
  expect(options?.expires).toBeLessThanOrEqual(Date.now() + 300_000);
});

it('withholds incomplete packages and object keys outside the pinned run', async () => {
  getMetadata.mockRejectedValueOnce({ code: 404 });
  await expect(
    getVerifiedPremiumPrintPackage(storyId, runId, source, 'self-print'),
  ).resolves.toBeNull();
  getCheckpoint
    .mockResolvedValueOnce(source)
    .mockResolvedValueOnce({ ...pack, interior: { ...pack.interior, key: 'other.pdf' } });
  await expect(
    getVerifiedPremiumPrintPackage(storyId, runId, source, 'self-print'),
  ).resolves.toBeNull();
  expect(getSignedUrl).not.toHaveBeenCalled();
});
