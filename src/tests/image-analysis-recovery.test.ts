import { recoverableImageAnalysis } from '@/services/image-analysis.js';

const complete = jest.fn();
const exists = jest.fn();
const download = jest.fn();
const upload = jest.fn();
jest.mock('@/services/storage-singleton.js', () => ({
  getStorageService: () => ({
    fileExists: exists,
    downloadFile: download,
    downloadFileAsBuffer: async () => Buffer.from('image'),
    getFileMetadata: async () => ({ contentType: 'image/jpeg' }),
    uploadFile: upload,
  }),
}));
jest.mock('@/ai/gateway-with-tracking.js', () => ({
  getAIGatewayWithTokenTracking: () => ({
    getImageAnalysisTextService: () => ({ provider: 'google-genai', service: { complete } }),
  }),
}));
jest.mock('@/services/prompt.js', () => ({
  PromptService: {
    loadSharedPrompt: async () => ({}),
    buildParts: () => ({ userPrompt: '', systemInstruction: '' }),
  },
}));
jest.mock('@/services/schema.js', () => ({ SchemaService: { loadSchema: async () => ({}) } }));
const metadata = {
  overallImageContent: 'drawing',
  description: 'A drawing',
  text: '',
  characters: [],
};
beforeEach(() => {
  jest.clearAllMocks();
  exists.mockResolvedValue(false);
  upload.mockResolvedValue('url');
  complete.mockResolvedValue(JSON.stringify(metadata));
});

it('reuses the completed sibling after a response was lost', async () => {
  exists.mockResolvedValue(true);
  download.mockResolvedValue(JSON.stringify(metadata));
  await expect(recoverableImageAnalysis('author/inputs/a.jpg', 'en-US')).resolves.toEqual(metadata);
  expect(complete).not.toHaveBeenCalled();
});
it('coalesces concurrent attempts and conditionally creates one sibling', async () => {
  const results = await Promise.all([
    recoverableImageAnalysis('author/inputs/b.jpg', 'en-US'),
    recoverableImageAnalysis('author/inputs/b.jpg', 'en-US'),
  ]);
  expect(results).toEqual([metadata, metadata]);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(upload).toHaveBeenCalledWith(
    'author/inputs/b.json',
    expect.any(Buffer),
    'application/json',
    { ifGenerationMatch: 0 },
  );
});
it('returns the persisted winner when another instance wins the write', async () => {
  upload.mockRejectedValue({ code: 412 });
  download.mockResolvedValue(JSON.stringify(metadata));
  await expect(recoverableImageAnalysis('author/inputs/c.jpg', 'en-US')).resolves.toEqual(metadata);
});
it.each(['{', '{}'])('rejects invalid model output %s without persisting', async (raw) => {
  complete.mockResolvedValue(raw);
  await expect(recoverableImageAnalysis('author/inputs/d.jpg', 'en-US')).rejects.toMatchObject({
    code: 'invalid_response',
  });
  expect(upload).not.toHaveBeenCalled();
});
it.each([
  [429, 'provider_busy'],
  [503, 'provider_busy'],
])('classifies provider status %s', async (status, code) => {
  complete.mockRejectedValue({ status });
  await expect(recoverableImageAnalysis('author/inputs/e.jpg', 'en-US')).rejects.toMatchObject({
    code,
  });
});
it('classifies persistence failure', async () => {
  upload.mockRejectedValue(new Error('private storage detail'));
  await expect(recoverableImageAnalysis('author/inputs/f.jpg', 'en-US')).rejects.toMatchObject({
    code: 'storage_failure',
  });
});

it('classifies a safety rejection without persisting provider details', async () => {
  complete.mockRejectedValue(new Error('blocked by safety filter: private content'));
  await expect(recoverableImageAnalysis('author/inputs/g.jpg', 'en-US')).rejects.toMatchObject({
    code: 'content_rejected',
    message: 'content_rejected',
  });
  expect(upload).not.toHaveBeenCalled();
});
it('times out without saving a late provider response', async () => {
  jest.useFakeTimers();
  try {
    let finish!: (value: string) => void;
    complete.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const work = recoverableImageAnalysis('author/inputs/h.jpg', 'en-US');
    const rejection = expect(work).rejects.toMatchObject({ code: 'timeout' });
    await jest.advanceTimersByTimeAsync(50000);
    await rejection;
    finish(JSON.stringify(metadata));
    await Promise.resolve();
    expect(upload).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
