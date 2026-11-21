import { once } from 'events';
import { createRequire } from 'module';
import type { AddressInfo } from 'net';
import type { LiveServerMessage } from '@google/genai';
import { startBiographerLiveGateway } from './live-gateway.js';

const mockConnect = jest.fn();
const mockClose = jest.fn();
const mockSendContent = jest.fn();
const mockSendAudio = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn(() => ({ live: { connect: (...args: unknown[]) => mockConnect(...args) } })),
  Modality: { AUDIO: 'AUDIO' },
}));
jest.mock('./instructions.js', () => ({
  INTERVIEWER_INSTRUCTION: 'Ask one question; never invent memories.',
}));
const Ws = createRequire(`${process.cwd()}/package.json`)('ws') as {
  new (
    url: string,
    options: object,
  ): {
    on: (name: string, fn: (data: Buffer) => void) => void;
    once: (name: string, fn: (...args: unknown[]) => void) => void;
    send: (data: string) => void;
    close: () => void;
  };
};
const projectId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const participantId = '33333333-3333-4333-8333-333333333333';
const authorId = '44444444-4444-4444-8444-444444444444';
const leaseId = '55555555-5555-4555-8555-555555555555';
const turnId = '66666666-6666-4666-8666-666666666666';

describe('Biographer live gateway protocol', () => {
  const originalFetch = global.fetch;
  let gateway: ReturnType<typeof startBiographerLiveGateway>;
  let serverEvent: (event: LiveServerMessage) => void;
  beforeEach(async () => {
    process.env.BIOGRAPHER_LIVE_ENABLED = 'true';
    process.env.BIOGRAPHER_ALLOWED_ORIGINS = 'https://mythoria.test';
    process.env.BIOGRAPHER_WEBAPP_URL = 'https://mythoria.test';
    process.env.BIOGRAPHER_INTERNAL_API_KEY = 'private-service-key';
    process.env.PORT = '0';
    jest.clearAllMocks();
    mockConnect.mockImplementation(async ({ callbacks }) => {
      serverEvent = callbacks.onmessage;
      return {
        close: mockClose,
        sendClientContent: mockSendContent,
        sendRealtimeInput: mockSendAudio,
      };
    });
    global.fetch = jest.fn(async (url) => {
      const body = String(url).endsWith('/admit')
        ? {
            participantId,
            authorId,
            leaseId,
            locale: 'en-US',
            history: [],
            context: {},
            remainingSeconds: 100,
          }
        : { allowed: true, remainingSeconds: 99 };
      return { ok: true, json: async () => body } as Response;
    });
    gateway = startBiographerLiveGateway();
    await once(gateway.http, 'listening');
  });
  afterEach(async () => {
    gateway.shutdown();
    global.fetch = originalFetch;
    process.removeListener('SIGTERM', gateway.shutdown);
    process.removeListener('SIGINT', gateway.shutdown);
  });
  it('never opens a provider session after admission is denied', async () => {
    global.fetch = jest.fn(async () => ({ ok: false }) as Response);
    const port = (gateway.http.address() as AddressInfo).port;
    const socket = new Ws(`ws://127.0.0.1:${port}/live`, {
      headers: { Origin: 'https://mythoria.test' },
    });
    const closed = once(socket as never, 'close');
    await once(socket as never, 'open');
    socket.send(
      JSON.stringify({
        type: 'authenticate',
        ticket: 'invalid-single-use-ticket',
        projectId,
        sessionId,
      }),
    );
    await closed;
    expect(mockConnect).not.toHaveBeenCalled();
  });
  it('does not acknowledge a transcript when its durable checkpoint fails', async () => {
    const port = (gateway.http.address() as AddressInfo).port;
    const socket = new Ws(`ws://127.0.0.1:${port}/live`, {
      headers: { Origin: 'https://mythoria.test' },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.on('message', (raw) => events.push(JSON.parse(raw.toString())));
    await once(socket as never, 'open');
    socket.send(
      JSON.stringify({
        type: 'authenticate',
        ticket: 'a-valid-single-use-ticket',
        projectId,
        sessionId,
      }),
    );
    await waitFor(() => events.some((event) => event.type === 'ready'));
    socket.send(JSON.stringify({ type: 'audio', turnId, data: 'AAAA' }));
    await waitFor(() => mockSendAudio.mock.calls.length > 0);
    global.fetch = jest.fn(async () => ({ ok: false }) as Response);
    serverEvent({
      serverContent: { inputTranscription: { text: 'Pending memory', finished: true } },
    } as LiveServerMessage);
    await waitFor(() => events.some((event) => event.type === 'error'));
    expect(events.some((event) => event.type === 'transcript')).toBe(false);
    socket.close();
  });
  it('forwards interruptions and media in order while a transcript checkpoint is pending', async () => {
    const port = (gateway.http.address() as AddressInfo).port;
    const socket = new Ws(`ws://127.0.0.1:${port}/live`, {
      headers: { Origin: 'https://mythoria.test' },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.on('message', (raw) => events.push(JSON.parse(raw.toString())));
    await once(socket as never, 'open');
    socket.send(
      JSON.stringify({
        type: 'authenticate',
        ticket: 'a-valid-single-use-ticket',
        projectId,
        sessionId,
      }),
    );
    await waitFor(() => events.some((event) => event.type === 'ready'));
    let resolveCheckpoint!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveCheckpoint = resolve;
    });
    let checkpoints = 0;
    global.fetch = jest.fn(async (url) => {
      if (String(url).endsWith('/checkpoint') && checkpoints++ === 0) return pending;
      return { ok: true, json: async () => ({}) } as Response;
    });
    serverEvent({ serverContent: { outputTranscription: { text: 'Hello', finished: true } } });
    await waitFor(() => (global.fetch as jest.Mock).mock.calls.length > 0);
    serverEvent({
      serverContent: {
        interrupted: true,
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] },
      },
    });
    serverEvent({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'BBBB' } }] },
      },
    });
    await waitFor(() => events.filter((event) => event.type === 'media').length === 2);
    expect(
      events.filter((event) => event.type === 'interrupted' || event.type === 'media'),
    ).toEqual([
      { type: 'interrupted' },
      { type: 'media', mimeType: 'audio/pcm;rate=24000', data: 'AAAA' },
      { type: 'media', mimeType: 'audio/pcm;rate=24000', data: 'BBBB' },
    ]);
    expect(events.some((event) => event.type === 'transcript')).toBe(false);
    resolveCheckpoint({ ok: true, json: async () => ({}) } as Response);
    await waitFor(() =>
      events.some((event) => event.type === 'transcript' && event.interrupted === true),
    );
    expect(events.filter((event) => event.type === 'interrupted')).toHaveLength(1);
    socket.close();
  });
  it('does not persist transcription of the synthetic startup instruction', async () => {
    const port = (gateway.http.address() as AddressInfo).port;
    const socket = new Ws(`ws://127.0.0.1:${port}/live`, {
      headers: { Origin: 'https://mythoria.test' },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.on('message', (raw) => events.push(JSON.parse(raw.toString())));
    await once(socket as never, 'open');
    socket.send(
      JSON.stringify({
        type: 'authenticate',
        ticket: 'a-valid-single-use-ticket',
        projectId,
        sessionId,
      }),
    );
    await waitFor(() => events.some((event) => event.type === 'ready'));
    serverEvent({
      serverContent: { inputTranscription: { text: 'Begin the interview', finished: true } },
    } as LiveServerMessage);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([url]) => String(url).endsWith('/checkpoint')),
    ).toBe(false);
    socket.close();
  });
  it('authorizes before opening Gemini, saves transcript before acknowledgement and preserves audio turn IDs', async () => {
    const port = (gateway.http.address() as AddressInfo).port;
    const socket = new Ws(`ws://127.0.0.1:${port}/live`, {
      headers: { Origin: 'https://mythoria.test' },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.on('message', (raw) => events.push(JSON.parse(raw.toString())));
    await once(socket as never, 'open');
    expect(mockConnect).not.toHaveBeenCalled();
    socket.send(
      JSON.stringify({
        type: 'authenticate',
        ticket: 'a-valid-single-use-ticket',
        projectId,
        sessionId,
      }),
    );
    await waitFor(() => events.some((event) => event.type === 'ready'));
    socket.send(JSON.stringify({ type: 'audio', turnId, data: 'AAAA' }));
    await waitFor(() => mockSendAudio.mock.calls.length > 0);
    serverEvent({
      serverContent: { inputTranscription: { text: 'The map was wrong.', finished: true } },
    } as LiveServerMessage);
    await waitFor(() => events.some((event) => event.type === 'transcript'));
    expect(events.find((event) => event.type === 'transcript')).toMatchObject({
      turnId,
      role: 'user',
      final: true,
      text: 'The map was wrong.',
    });
    const commits = (global.fetch as jest.Mock).mock.calls.filter(([url]) =>
      String(url).endsWith('/checkpoint'),
    );
    expect(JSON.parse(commits[0]?.[1].body)).toMatchObject({ turnId, text: 'The map was wrong.' });
    expect(mockConnect.mock.calls[0]?.[0].model).toBe('gemini-3.8-live');
    expect(mockConnect.mock.calls[0]?.[0].config.responseModalities).toEqual(['AUDIO']);
    socket.close();
  });
  it('continues checkpointing after provider usage metadata follows a reply', async () => {
    const port = (gateway.http.address() as AddressInfo).port;
    const socket = new Ws(`ws://127.0.0.1:${port}/live`, {
      headers: { Origin: 'https://mythoria.test' },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.on('message', (raw) => events.push(JSON.parse(raw.toString())));
    await once(socket as never, 'open');
    socket.send(
      JSON.stringify({
        type: 'authenticate',
        ticket: 'a-valid-single-use-ticket',
        projectId,
        sessionId,
      }),
    );
    await waitFor(() => events.some((event) => event.type === 'ready'));
    socket.send(JSON.stringify({ type: 'audio', turnId, data: 'AAAA' }));
    await waitFor(() => mockSendAudio.mock.calls.length > 0);
    serverEvent({ serverContent: { inputTranscription: { text: 'A memory', finished: true } } });
    serverEvent({ usageMetadata: { totalTokenCount: 12 } });
    serverEvent({
      serverContent: { outputTranscription: { text: 'Tell me more.', finished: true } },
    });
    await waitFor(() => events.some((event) => event.role === 'assistant'));
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(
      (global.fetch as jest.Mock).mock.calls.some(
        ([url, options]) =>
          String(url).endsWith('/lease') && JSON.parse(options.body).action === 'heartbeat',
      ),
    ).toBe(false);
    socket.close();
  });
  it('rotates capture before checkpoint completion while preserving saved turn order', async () => {
    const port = (gateway.http.address() as AddressInfo).port;
    const socket = new Ws(`ws://127.0.0.1:${port}/live`, {
      headers: { Origin: 'https://mythoria.test' },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.on('message', (raw) => events.push(JSON.parse(raw.toString())));
    await once(socket as never, 'open');
    socket.send(
      JSON.stringify({
        type: 'authenticate',
        ticket: 'a-valid-single-use-ticket',
        projectId,
        sessionId,
      }),
    );
    await waitFor(() => events.some((event) => event.type === 'ready'));
    let release!: (value: Response) => void;
    const firstCheckpoint = new Promise<Response>((resolve) => {
      release = resolve;
    });
    global.fetch = jest
      .fn()
      .mockImplementationOnce(() => firstCheckpoint)
      .mockResolvedValue({ ok: true, json: async () => ({}) });
    socket.send(JSON.stringify({ type: 'audio', turnId, data: 'AAAA' }));
    await waitFor(() => mockSendAudio.mock.calls.length > 0);
    serverEvent({ serverContent: { inputTranscription: { text: 'First', finished: true } } });
    await waitFor(() => events.some((event) => event.type === 'capture_boundary'));
    const boundary = events.find((event) => event.type === 'capture_boundary')!;
    expect(boundary.turnId).toBe(turnId);
    expect(boundary.nextTurnId).not.toBe(turnId);
    expect(events.some((event) => event.type === 'transcript')).toBe(false);
    socket.send(JSON.stringify({ type: 'audio', turnId: boundary.nextTurnId, data: 'BBBB' }));
    await waitFor(() => mockSendAudio.mock.calls.length > 1);
    serverEvent({ serverContent: { inputTranscription: { text: 'Second', finished: true } } });
    release({ ok: true, json: async () => ({}) } as Response);
    await waitFor(() => events.filter((event) => event.type === 'transcript').length === 2);
    expect(events.filter((event) => event.type === 'transcript')).toEqual([
      expect.objectContaining({ turnId, text: 'First' }),
      expect.objectContaining({ turnId: boundary.nextTurnId, text: 'Second' }),
    ]);
    socket.close();
  });
});
async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition did not complete');
}
