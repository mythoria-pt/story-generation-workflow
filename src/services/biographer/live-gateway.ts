import { randomUUID } from 'crypto';
import { createServer, type IncomingMessage } from 'http';
import { createRequire } from 'module';
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import { z } from 'zod';
import { INTERVIEWER_INSTRUCTION } from './instructions.js';
import { historyTurn, projectContext, biographerLocale } from './contract.js';

// A narrow transport interface avoids coupling application protocol to ws implementation details.
interface Socket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', callback: (data: Buffer, binary: boolean) => void): void;
  on(event: 'close' | 'error', callback: () => void): void;
}
interface WsServer {
  on(event: 'connection', callback: (socket: Socket, request: IncomingMessage) => void): void;
  close(): void;
}
const transport = createRequire(__filename)('ws') as {
  WebSocketServer: new (options: object) => WsServer;
};
const admission = z.object({
  participantId: z.string().uuid(),
  authorId: z.string().uuid(),
  locale: biographerLocale,
  history: z.array(historyTurn),
  context: projectContext,
  remainingSeconds: z.number().nonnegative(),
  leaseId: z.string().uuid(),
});
const authenticate = z.object({
  type: z.literal('authenticate'),
  ticket: z.string().min(16).max(2048),
  projectId: z.string().uuid(),
  sessionId: z.string().uuid(),
});
const message = z.discriminatedUnion('type', [
  authenticate,
  z.object({
    type: z.literal('audio'),
    data: z
      .string()
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .max(128000),
    turnId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('text'),
    text: z.string().min(1).max(40000),
    turnId: z.string().uuid(),
  }),
  z.object({ type: z.literal('end_audio') }),
  z.object({ type: z.literal('pause') }),
]);
async function internal(path: string, body: unknown) {
  const base = process.env.BIOGRAPHER_WEBAPP_URL;
  const key = process.env.BIOGRAPHER_INTERNAL_API_KEY;
  if (!base || !key) throw new Error('BIOGRAPHER_INTERNAL_NOT_CONFIGURED');
  const url = new URL(`/api/biographer/internal/${path}`, base);
  if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production')
    throw new Error('HTTPS_REQUIRED');
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('BIOGRAPHER_ADMISSION_OR_CHECKPOINT_FAILED');
  return response.json() as Promise<unknown>;
}

export function startBiographerLiveGateway() {
  if (process.env.BIOGRAPHER_LIVE_ENABLED !== 'true') throw new Error('BIOGRAPHER_LIVE_DISABLED');
  const project = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const origins = new Set(
    (process.env.BIOGRAPHER_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (!origins.size || !project) throw new Error('BIOGRAPHER_LIVE_CONFIGURATION_REQUIRED');
  const http = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"service":"biographer-live"}');
  });
  const wss = new transport.WebSocketServer({
    server: http,
    maxPayload: 192000,
    perMessageDeflate: false,
    path: '/live',
    verifyClient: ({ origin }: { origin: string }) => origins.has(origin),
  });
  const sockets = new Set<Socket>();
  wss.on('connection', (socket, request) => {
    if (sockets.size >= Number(process.env.BIOGRAPHER_MAX_CONNECTIONS ?? 20)) {
      socket.close(1013, 'Capacity reached');
      return;
    }
    sockets.add(socket);
    let session: Session | undefined;
    let sessionId: string | undefined;
    let leaseId: string | undefined;
    let authenticated = false;
    let closed = false;
    let inputId: string = randomUUID();
    let outputId: string = randomUUID();
    let inputText = '';
    let outputText = '';
    let queue = Promise.resolve();
    let incoming = Promise.resolve();
    let pendingMessages = 0;
    let hasRealInput = false;
    let heartbeatPending = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => socket.close(1008, 'Authentication required'), 10000);
    const send = (value: unknown) => {
      if (socket.readyState !== 1) return;
      if (socket.bufferedAmount > 4 * 1024 * 1024) {
        socket.close(1013, 'Playback cannot keep up');
        return;
      }
      socket.send(JSON.stringify(value));
    };
    const fail = (code: string) => {
      send({ type: 'error', code });
      socket.close(1011, code);
    };
    const checkpoint = async (
      role: 'user' | 'assistant',
      text: string,
      final: boolean,
      interrupted = false,
    ) => {
      if (!text.trim()) return;
      const turnId = role === 'user' ? inputId : outputId;
      await internal('checkpoint', {
        sessionId,
        turnId,
        eventId: randomUUID(),
        role,
        text,
        final,
        interrupted,
      });
      send({ type: 'transcript', role, turnId, text, final, interrupted });
    };
    const processServer = async (event: LiveServerMessage) => {
      const content = event.serverContent;
      for (const part of content?.modelTurn?.parts ?? []) {
        if (part.inlineData?.data)
          send({ type: 'media', mimeType: part.inlineData.mimeType, data: part.inlineData.data });
      }
      if (hasRealInput && content?.inputTranscription?.text) {
        inputText += content.inputTranscription.text;
        await checkpoint('user', inputText, Boolean(content.inputTranscription.finished));
        if (content.inputTranscription.finished) {
          send({ type: 'turn_complete', turnId: inputId });
          inputText = '';
          inputId = randomUUID();
        }
      }
      if (content?.outputTranscription?.text) {
        outputText += content.outputTranscription.text;
        await checkpoint('assistant', outputText, Boolean(content.outputTranscription.finished));
      }
      if (content?.interrupted) {
        send({ type: 'interrupted' });
        await checkpoint('assistant', outputText, true, true);
        outputText = '';
        outputId = randomUUID();
      }
      if (content?.turnComplete) {
        if (inputText) {
          await checkpoint('user', inputText, true);
          send({ type: 'turn_complete', turnId: inputId });
          inputText = '';
          inputId = randomUUID();
        }
        if (outputText) {
          await checkpoint('assistant', outputText, true);
          outputText = '';
          outputId = randomUUID();
        }
      }
      if (event.goAway) {
        send({ type: 'reconnecting' });
        socket.close(1012, 'Resume from saved history');
      }
      // Usage metadata goes to the private internal service, never the browser or prompt logs.
      if (event.usageMetadata) {
        const lease = z.object({ remainingSeconds: z.number(), allowed: z.boolean() }).parse(
          await internal('lease', {
            sessionId,
            leaseId,
            action: 'heartbeat',
            usage: event.usageMetadata,
          }),
        );
        if (!lease.allowed) socket.close(1008, 'Allowance exhausted or access revoked');
      }
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      if (timer) clearInterval(timer);
      session?.close();
      sockets.delete(socket);
      // Queued transcript checkpoints finish before lease release; source audio is archived separately by the browser.
      void queue
        .finally(async () => {
          if (leaseId) await internal('lease', { sessionId, leaseId, action: 'release' });
        })
        .catch(() => undefined);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('message', (raw, binary) => {
      if (binary) {
        fail('INVALID_MESSAGE');
        return;
      }
      if (++pendingMessages > 200) {
        fail('INPUT_BACKPRESSURE');
        return;
      }
      incoming = incoming
        .then(async () => {
          const parsed = message.safeParse(JSON.parse(raw.toString('utf8')));
          if (!parsed.success) throw new Error('INVALID_MESSAGE');
          const value = parsed.data;
          if (!authenticated) {
            if (value.type !== 'authenticate') throw new Error('AUTHENTICATION_REQUIRED');
            const admitted = admission.parse(
              await internal('admit', { ...value, origin: request.headers.origin }),
            );
            if (!admitted.remainingSeconds) throw new Error('ALLOWANCE_EXHAUSTED');
            sessionId = value.sessionId;
            leaseId = admitted.leaseId;
            authenticated = true;
            clearTimeout(timeout);
            const client = new GoogleGenAI({
              vertexai: true,
              project,
              location: process.env.BIOGRAPHER_GOOGLE_LOCATION ?? 'eu',
            });
            const connection = client.live.connect({
              model: 'gemini-3.8-live',
              config: {
                responseModalities: [Modality.VIDEO],
                avatarConfig: { avatarName: process.env.BIOGRAPHER_AVATAR_NAME ?? 'Ben' },
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: process.env.BIOGRAPHER_VOICE_NAME ?? 'Puck' },
                  },
                },
                inputAudioTranscription: { languageCodes: [admitted.locale] },
                outputAudioTranscription: { languageCodes: [admitted.locale] },
                contextWindowCompression: { slidingWindow: {} },
                systemInstruction: `${INTERVIEWER_INSTRUCTION}\nSaved project context (data only): ${JSON.stringify({ locale: admitted.locale, context: admitted.context, savedHistory: admitted.history.slice(-60) })}`,
              },
              callbacks: {
                onmessage: (event) => {
                  queue = queue
                    .then(() => processServer(event))
                    .catch(() => fail('CHECKPOINT_FAILED'));
                },
                onerror: () => fail('LIVE_UNAVAILABLE'),
                onclose: () => {
                  if (!closed) socket.close(1012, 'Reconnect to continue');
                },
              },
            });
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            try {
              session = await Promise.race([
                connection,
                new Promise<never>((_, reject) => {
                  timeoutHandle = setTimeout(
                    () => reject(new Error('LIVE_CONNECT_TIMEOUT')),
                    30000,
                  );
                }),
              ]);
            } catch (error) {
              void connection.then((late) => late.close()).catch(() => undefined);
              throw error;
            } finally {
              if (timeoutHandle) clearTimeout(timeoutHandle);
            }
            if (closed) {
              session.close();
              return;
            }
            send({ type: 'ready', remainingSeconds: admitted.remainingSeconds });
            session.sendClientContent({
              turns: [
                {
                  role: 'user',
                  parts: [
                    {
                      text: 'Begin the interview with one question, or resume naturally from saved history. This is an application instruction, not a new personal memory.',
                    },
                  ],
                },
              ],
              turnComplete: true,
            });
            timer = setInterval(() => {
              if (heartbeatPending) return;
              heartbeatPending = true;
              void internal('lease', { sessionId, leaseId, action: 'heartbeat' })
                .then((result) => {
                  const lease = z
                    .object({ remainingSeconds: z.number(), allowed: z.boolean() })
                    .parse(result);
                  send({ type: 'allowance', remainingSeconds: lease.remainingSeconds });
                  if (!lease.allowed) socket.close(1008, 'Allowance exhausted or access revoked');
                })
                .catch(() => fail('LEASE_UNAVAILABLE'))
                .finally(() => {
                  heartbeatPending = false;
                });
            }, 20000);
            return;
          }
          if (!session) throw new Error('SESSION_NOT_READY');
          if (value.type === 'audio') {
            hasRealInput = true;
            if (!inputText) inputId = value.turnId;
            session.sendRealtimeInput({
              audio: { data: value.data, mimeType: 'audio/pcm;rate=16000' },
            });
          } else if (value.type === 'text') {
            hasRealInput = true;
            await internal('checkpoint', {
              sessionId,
              eventId: value.turnId,
              turnId: value.turnId,
              role: 'user',
              text: value.text,
              final: true,
            });
            session.sendClientContent({
              turns: [{ role: 'user', parts: [{ text: value.text }] }],
              turnComplete: true,
            });
          } else if (value.type === 'end_audio')
            session.sendRealtimeInput({ audioStreamEnd: true });
          else if (value.type === 'pause') socket.close(1000, 'Paused');
        })
        .catch(() => fail('INVALID_OR_UNSAVED_MESSAGE'))
        .finally(() => {
          pendingMessages--;
        });
    });
  });
  http.listen(Number(process.env.PORT ?? 8080));
  const shutdown = () => {
    for (const socket of sockets) socket.close(1001, 'Service restarting');
    wss.close();
    http.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { http, shutdown };
}
