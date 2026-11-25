import { randomUUID } from 'crypto';
import { createServer, type IncomingMessage } from 'http';
import { createRequire } from 'module';
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import winston from 'winston';
import { z } from 'zod';
import {
  INTERVIEWER_INSTRUCTION,
  WHISPERER_INSTRUCTION,
  WHISPERER_LIVE_OUTLINE_INSTRUCTION,
} from './instructions.js';
import { historyTurn, projectContext, biographerLocale } from './contract.js';

// The gateway runs without the main workflow service's database and storage configuration.
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: { service: 'biographer-live' },
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});
const inputFinalTimeoutMs = 15_000;
const inputQuietGraceMs = 1800;
const unconfirmedSpeechGraceMs = 4000;
type InputEndReason = 'SPEECH_ACTIVITY_ENDED' | 'PROVIDER_IDLE' | 'AUDIO_STREAM_ENDED';

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
  mode: z.enum(['biography', 'story-whisperer']).optional(),
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
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('prepare_outline'), requestId: z.string().uuid() }),
  z.object({ type: z.literal('resume_outline') }),
  z.object({
    type: z.literal('advance_to_outline_result'),
    callId: z.string().min(1).max(256),
    accepted: z.boolean(),
  }),
]);
function mayContainSpeech(data: string) {
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length % 2) return true;
  let squares = 0;
  for (let offset = 0; offset < bytes.length; offset += 2)
    squares += bytes.readInt16LE(offset) ** 2;
  // Match the browser's Story Whisperer archival threshold for 16-bit PCM.
  return bytes.length > 0 && squares >= (bytes.length / 2) * 64 ** 2;
}

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
    const connectedAt = performance.now();
    let session: Session | undefined;
    let sessionId: string | undefined;
    let leaseId: string | undefined;
    let authenticated = false;
    let closed = false;
    let inputTurn:
      | {
          id: string;
          text: string;
          mayContainSpeech: boolean;
          speechDetected?: boolean;
          activitySpeaking?: boolean;
          activityEnded?: boolean;
          endReason: InputEndReason | undefined;
          lastSignalAt: number;
        }
      | undefined;
    let captureId: string | undefined;
    let inputFinalTimer: ReturnType<typeof setTimeout> | undefined;
    let inputQuietTimer: ReturnType<typeof setTimeout> | undefined;
    let goAwayTimer: ReturnType<typeof setTimeout> | undefined;
    let outputTurn = { id: randomUUID(), text: '', final: false };
    let queue = Promise.resolve();
    let incoming = Promise.resolve();
    let pendingMessages = 0;
    let checkpointFailed = false;
    let whisperer = false;
    let finalUserTurnId: string | undefined;
    let durableUserTurnId: string | undefined;
    let lastOutlineTurnId: string | undefined;
    let outline:
      | { callId: string; turnId: string; sent: boolean; timer: ReturnType<typeof setTimeout> }
      | undefined;
    let prepareOutline:
      { requestId: string; turnId: string | undefined; startedAt: number } | undefined;
    let outlinePrepared = false;
    let prepareTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatPending = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let allowanceDeadline: ReturnType<typeof setTimeout> | undefined;
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
      logger.warn('Biographer live gateway failure', { reason: code });
      send({ type: 'error', code });
      socket.close(1011, code);
    };
    const respondToTool = (callId: string, name: string, accepted: boolean) => {
      if (closed || checkpointFailed) return;
      try {
        session?.sendToolResponse({
          functionResponses: [{ id: callId, name, response: { accepted } }],
        });
      } catch {
        fail('LIVE_UNAVAILABLE');
      }
    };
    const clearOutline = () => {
      if (outline) clearTimeout(outline.timer);
      outline = undefined;
    };
    const reconnectForInput = (reason: string) => {
      logger.info('Story Whisperer voice input incomplete', { reason });
      send({ type: 'reconnecting' });
      cleanup();
      socket.close(1012, 'Resume from saved history');
    };
    const reconnectAfterGoAway = () => {
      if (closed) return;
      if (whisperer && inputTurn?.mayContainSpeech) reconnectForInput('PROVIDER_GO_AWAY');
      else {
        send({ type: 'reconnecting' });
        socket.close(1012, 'Resume from saved history');
      }
    };
    const waitForInputFinal = (reason: string) => {
      if (inputFinalTimer || !inputTurn?.mayContainSpeech) return;
      const turnId = inputTurn.id;
      const startedAt = performance.now();
      const expire = () => {
        if (closed || inputTurn?.id !== turnId) return;
        const remaining = inputFinalTimeoutMs - (performance.now() - inputTurn.lastSignalAt);
        if (remaining > 0 && inputTurn.endReason !== 'AUDIO_STREAM_ENDED') {
          inputFinalTimer = setTimeout(expire, remaining);
          return;
        }
        logger.info('Story Whisperer voice finalization timed out', {
          elapsedMs: Math.round(performance.now() - startedAt),
          reason,
        });
        reconnectForInput('INPUT_FINAL_TIMEOUT');
      };
      inputFinalTimer = setTimeout(expire, inputFinalTimeoutMs);
    };
    const notifyOutlineAfterCheckpoints = () => {
      const fence = queue;
      void fence.then(() => {
        if (closed || checkpointFailed) return;
        if (queue !== fence) return;

        if (outline && !outline.sent && outline.turnId === durableUserTurnId) {
          outline.sent = true;
          send({ type: 'advance_to_outline', callId: outline.callId, turnId: outline.turnId });
        }
        if (prepareOutline && !prepareOutline.turnId) {
          if (prepareTimer) clearTimeout(prepareTimer);
          outlinePrepared = true;
          outputTurn = { id: randomUUID(), text: '', final: false };
          send({ type: 'outline_prepared', requestId: prepareOutline.requestId });
          logger.info('Story Whisperer voice outline preparation', {
            elapsedMs: Math.round(performance.now() - prepareOutline.startedAt),
          });
          prepareOutline = undefined;
        }
      });
    };
    const checkpoint = (
      role: 'user' | 'assistant',
      turnId: string,
      text: string,
      final: boolean,
      interrupted = false,
    ) => {
      if (!text.trim()) return;
      const queuedAt = performance.now();
      queue = queue
        .then(async () => {
          if (checkpointFailed) return;
          const startedAt = performance.now();
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
          if (role === 'user' && final) {
            if (whisperer)
              logger.info('Story Whisperer final voice checkpoint', {
                queueMs: Math.round(startedAt - queuedAt),
                saveMs: Math.round(performance.now() - startedAt),
              });
            durableUserTurnId = turnId;
            send({ type: 'turn_complete', turnId });
          }
        })
        .catch(() => {
          checkpointFailed = true;
          fail('CHECKPOINT_FAILED');
        });
    };
    const sealInput = () => {
      if (!inputTurn) return;
      if (inputTurn.text.trim()) finalUserTurnId = inputTurn.id;
      checkpoint('user', inputTurn.id, inputTurn.text, true);
      if (inputFinalTimer) clearTimeout(inputFinalTimer);
      if (inputQuietTimer) clearTimeout(inputQuietTimer);
      inputFinalTimer = undefined;
      inputQuietTimer = undefined;
      captureId = randomUUID();
      // Capture rotation is immediate; saved transcript events still await durable checkpoints.
      send({ type: 'capture_boundary', turnId: inputTurn.id, nextTurnId: captureId });
      if (prepareOutline?.turnId === inputTurn.id) prepareOutline.turnId = undefined;
      inputTurn = undefined;
    };
    const waitForQuietInput = (endReason?: InputEndReason) => {
      if (!inputTurn) return;
      if (inputTurn.endReason !== 'AUDIO_STREAM_ENDED')
        inputTurn.endReason = endReason ?? inputTurn.endReason;
      if (inputQuietTimer || !inputTurn.endReason || !inputTurn.text.trim()) return;
      const turnId = inputTurn.id;
      const startedAt = performance.now();
      const settle = () => {
        inputQuietTimer = undefined;
        if (closed || checkpointFailed || inputTurn?.id !== turnId || !inputTurn.endReason) return;
        if (inputTurn.activitySpeaking && inputTurn.endReason !== 'AUDIO_STREAM_ENDED') return;
        const remaining = inputQuietGraceMs - (performance.now() - inputTurn.lastSignalAt);
        if (remaining > 0) {
          inputQuietTimer = setTimeout(settle, remaining);
          return;
        }
        logger.info('Story Whisperer voice finalized after quiet input', {
          elapsedMs: Math.round(performance.now() - startedAt),
          reason: inputTurn.endReason,
        });
        sealInput();
        notifyOutlineAfterCheckpoints();
      };
      inputQuietTimer = setTimeout(settle, inputQuietGraceMs);
    };
    const processServer = (event: LiveServerMessage) => {
      const content = event.serverContent;
      const input = content?.inputTranscription;
      if (inputTurn) {
        const activity = event.voiceActivity?.voiceActivityType;
        if (whisperer && inputTurn.activityEnded && activity === 'ACTIVITY_START') {
          // The provider does not tag text with a turn ID. Preserve saved text rather than
          // attribute the next speech activity to the unfinished answer.
          reconnectForInput('OVERLAPPING_INPUT_ACTIVITY');
          return;
        }
        if (whisperer) {
          if (activity === 'ACTIVITY_START') {
            inputTurn.activitySpeaking = true;
            if (inputTurn.endReason !== 'AUDIO_STREAM_ENDED') inputTurn.endReason = undefined;
          } else if (activity === 'ACTIVITY_END') {
            inputTurn.activitySpeaking = false;
            inputTurn.activityEnded = true;
          }
          if (input?.text?.trim() || content?.interimInputTranscription?.text?.trim() || activity)
            inputTurn.lastSignalAt = performance.now();
        }
        if (input?.text) inputTurn.text += input.text;
        if (
          whisperer &&
          !inputTurn.speechDetected &&
          (inputTurn.text.trim() ||
            content?.interimInputTranscription?.text?.trim() ||
            activity === 'ACTIVITY_START')
        ) {
          inputTurn.mayContainSpeech = true;
          inputTurn.speechDetected = true;
          send({ type: 'speech_detected', turnId: inputTurn.id });
          if (outline && outline.turnId !== inputTurn.id) {
            if (outline.sent)
              send({ type: 'advance_to_outline_cancelled', callId: outline.callId });
            respondToTool(outline.callId, 'advance_to_outline', false);
            clearOutline();
          }
        }
        const hasText = Boolean(inputTurn.text.trim());
        // Gemini's model turn and its input transcription are independent streams.
        const final = whisperer
          ? input?.finished === true && hasText
          : Boolean(input?.finished || (content?.turnComplete && hasText));
        if (final) {
          sealInput();
        } else {
          if (input?.text) checkpoint('user', inputTurn.id, inputTurn.text, false);
          if (whisperer) {
            if (activity === 'ACTIVITY_END') {
              waitForQuietInput('SPEECH_ACTIVITY_ENDED');
              waitForInputFinal('SPEECH_ACTIVITY_ENDED');
            } else if (
              content?.interactionStatus === 'IDLE' &&
              !content.interrupted &&
              !inputTurn.activitySpeaking &&
              inputTurn.speechDetected
            ) {
              waitForQuietInput('PROVIDER_IDLE');
              waitForInputFinal('PROVIDER_IDLE');
            } else if (input?.text) waitForQuietInput();
            if (content?.turnComplete && !content.interrupted && !inputTurn.activitySpeaking)
              waitForInputFinal('MODEL_TURN_COMPLETED');
            if (prepareOutline?.turnId === inputTurn.id) waitForInputFinal('OUTLINE_PREPARATION');
          }
        }
      }
      const output = outlinePrepared ? undefined : content?.outputTranscription;
      if (output?.text) outputTurn.text += output.text;
      const interrupted = Boolean(content?.interrupted);
      const final = Boolean(output?.finished || content?.turnComplete || interrupted);
      if (!outlinePrepared && (output?.text || (final && (!outputTurn.final || interrupted))))
        checkpoint('assistant', outputTurn.id, outputTurn.text, final, interrupted);
      outputTurn.final ||= final;
      if (content?.turnComplete || interrupted)
        outputTurn = { id: randomUUID(), text: '', final: false };

      const cancelledCalls = event.toolCallCancellation?.ids ?? [];
      for (const callId of cancelledCalls) {
        if (outline?.callId !== callId) continue;
        if (outline.sent) send({ type: 'advance_to_outline_cancelled', callId });
        clearOutline();
      }
      for (const call of event.toolCall?.functionCalls ?? []) {
        if (!call.id || !call.name || call.id.length > 256) continue;
        if (outline?.callId === call.id || cancelledCalls.includes(call.id)) continue;
        const turnId =
          inputTurn?.speechDetected || (!finalUserTurnId && inputTurn?.mayContainSpeech)
            ? inputTurn.id
            : finalUserTurnId;
        if (
          !whisperer ||
          call.name !== 'advance_to_outline' ||
          Object.keys(call.args ?? {}).length ||
          !turnId ||
          turnId === lastOutlineTurnId ||
          outline
        ) {
          respondToTool(call.id, call.name, false);
          continue;
        }
        const callId = call.id;
        lastOutlineTurnId = turnId;
        outline = {
          callId,
          turnId,
          sent: false,
          timer: setTimeout(() => {
            if (outline?.callId !== callId) return;
            if (outline.sent) send({ type: 'advance_to_outline_cancelled', callId });
            clearOutline();
            respondToTool(callId, 'advance_to_outline', false);
          }, 60000),
        };
      }
      if (content?.turnComplete) finalUserTurnId = undefined;
      if (outline || prepareOutline) notifyOutlineAfterCheckpoints();

      if (event.goAway) {
        const seconds = /^(\d+(?:\.\d+)?)s$/.exec(event.goAway.timeLeft ?? '')?.[1];
        const drainMs = Math.min(Number(seconds ?? 0) * 1000, 2000);
        if (whisperer && inputTurn?.mayContainSpeech && drainMs > 0) {
          if (!goAwayTimer) goAwayTimer = setTimeout(reconnectAfterGoAway, drainMs);
        } else reconnectAfterGoAway();
      }
    };
    const cleanup = (discardTurnIds?: string[]) => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      if (timer) clearInterval(timer);
      if (allowanceDeadline) clearTimeout(allowanceDeadline);
      clearOutline();
      if (prepareTimer) clearTimeout(prepareTimer);
      if (inputFinalTimer) clearTimeout(inputFinalTimer);
      if (inputQuietTimer) clearTimeout(inputQuietTimer);
      if (goAwayTimer) clearTimeout(goAwayTimer);
      session?.close();
      sockets.delete(socket);
      // The browser uses lease release to detect when transcript checkpoints have drained.
      void queue
        .finally(async () => {
          if (!leaseId) return;
          if (discardTurnIds) {
            await internal('lease', {
              sessionId,
              leaseId,
              action: 'discard',
              turnIds: discardTurnIds,
            });
          } else {
            await internal('lease', { sessionId, leaseId, action: 'release' });
          }
        })
        .catch(() => {
          logger.warn('Biographer live lease cleanup failed', {
            reason: discardTurnIds ? 'DISCARD_FAILED' : 'RELEASE_FAILED',
          });
        });
    };
    socket.on('close', () => cleanup());
    socket.on('error', () => cleanup());
    socket.on('message', (raw, binary) => {
      if (closed) return;
      if (binary) {
        fail('INVALID_MESSAGE');
        return;
      }
      // Accept cancellation before queued browser messages can delay provider shutdown.
      const parsed = (() => {
        try {
          return message.safeParse(JSON.parse(raw.toString('utf8')));
        } catch {
          return undefined;
        }
      })();
      if (!parsed?.success) {
        fail('INVALID_OR_UNSAVED_MESSAGE');
        return;
      }
      const value = parsed.data;
      if (value.type === 'cancel') {
        if (authenticated && !whisperer) {
          fail('INVALID_MESSAGE');
          return;
        }
        const turnIds = [
          inputTurn?.id,
          !outputTurn.final && outputTurn.text.trim() ? outputTurn.id : undefined,
        ].filter((id): id is string => Boolean(id));
        cleanup(turnIds);
        socket.close(1000, 'Cancelled');
        return;
      }
      if (++pendingMessages > 200) {
        fail('INPUT_BACKPRESSURE');
        return;
      }
      incoming = incoming
        .then(async () => {
          if (closed) return;
          if (!authenticated) {
            if (value.type !== 'authenticate') throw new Error('AUTHENTICATION_REQUIRED');
            const admitted = admission.parse(
              await internal('admit', { ...value, origin: request.headers.origin }),
            );
            sessionId = value.sessionId;
            leaseId = admitted.leaseId;
            if (closed) {
              await internal('lease', { sessionId, leaseId, action: 'release' });
              return;
            }
            if (!admitted.remainingSeconds) throw new Error('ALLOWANCE_EXHAUSTED');
            const expire = () => {
              send({ type: 'allowance', remainingSeconds: 0 });
              socket.close(1008, 'Allowance exhausted');
            };
            const deadlineMs = admitted.remainingSeconds * 1000;
            // Hour-scale Cloud Run connections are bounded by heartbeats and the platform timeout.
            if (deadlineMs <= 3600000) allowanceDeadline = setTimeout(expire, deadlineMs);
            authenticated = true;
            clearTimeout(timeout);
            const client = new GoogleGenAI({
              vertexai: true,
              project,
              location: process.env.BIOGRAPHER_GOOGLE_LOCATION ?? 'eu',
            });
            whisperer = admitted.mode === 'story-whisperer';
            const lastTurn = admitted.history.at(-1);
            const waitingForAnswer =
              whisperer &&
              (lastTurn?.role === 'assistant' || (!lastTurn && Boolean(admitted.context.opening)));
            const savedHistory = admitted.history.slice(-60);
            // Keep the preceding question if the recent window starts with its answer.
            if (whisperer && savedHistory[0]?.role === 'user') {
              const precedingTurn = admitted.history.at(-61);
              if (precedingTurn?.role === 'assistant') savedHistory.unshift(precedingTurn);
            }
            const liveContinuation = waitingForAnswer
              ? 'The latest spoken answer may refer to the pending question or opening shown in the saved context. Wait for the author to speak before continuing.'
              : 'After a saved author answer, ask a relevant new follow-up without repeating the opening.';
            const connection = client.live.connect({
              model: 'gemini-3.8-live',
              config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: process.env.BIOGRAPHER_VOICE_NAME ?? 'Puck' },
                  },
                },
                inputAudioTranscription: { languageCodes: [admitted.locale] },
                outputAudioTranscription: { languageCodes: [admitted.locale] },
                contextWindowCompression: { slidingWindow: {} },
                ...(whisperer && {
                  tools: [
                    {
                      functionDeclarations: [
                        {
                          name: 'advance_to_outline',
                          description:
                            'Request to leave the interview for the outline only when the current author explicitly asks to advance now. The application decides whether the story can advance.',
                        },
                      ],
                    },
                  ],
                }),
                systemInstruction: `${whisperer ? `${WHISPERER_INSTRUCTION}\n${WHISPERER_LIVE_OUTLINE_INSTRUCTION}\n${liveContinuation}` : INTERVIEWER_INSTRUCTION}\nSaved project context (data only): ${JSON.stringify({ locale: admitted.locale, context: admitted.context, savedHistory })}`,
              },
              callbacks: {
                onmessage: (event) => {
                  if (closed || checkpointFailed) return;
                  if (event.serverContent?.interrupted) send({ type: 'interrupted' });
                  for (const part of event.serverContent?.modelTurn?.parts ?? []) {
                    if (
                      !outlinePrepared &&
                      part.inlineData?.data &&
                      part.inlineData.mimeType?.startsWith('audio/pcm')
                    )
                      send({
                        type: 'media',
                        mimeType: part.inlineData.mimeType,
                        data: part.inlineData.data,
                      });
                  }
                  processServer(event);
                },
                onerror: () => {
                  if (closed) return;
                  logger.warn('Biographer live provider error');
                  fail('LIVE_UNAVAILABLE');
                },
                onclose: (event) => {
                  logger.info('Biographer live provider closed', {
                    code: Number.isInteger(event.code) ? event.code : undefined,
                  });
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
            if (whisperer)
              logger.info('Story Whisperer voice ready', {
                elapsedMs: Math.round(performance.now() - connectedAt),
              });
            if (!waitingForAnswer) {
              session.sendClientContent({
                turns: [
                  {
                    role: 'user',
                    parts: [
                      {
                        text: whisperer
                          ? lastTurn
                            ? 'Continue from the latest saved author answer with one new follow-up. This is an application instruction.'
                            : 'Ask one opening question to help this author make a story. This is an application instruction.'
                          : 'Begin the interview with one question, or resume naturally from saved history. This is an application instruction, not a new personal memory.',
                      },
                    ],
                  },
                ],
                turnComplete: true,
              });
            }
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
            // Frames already in transit at a boundary still carry the retired ID.
            if (whisperer && captureId && value.turnId !== captureId) return;
            if (
              whisperer &&
              (prepareOutline ||
                outlinePrepared ||
                goAwayTimer ||
                inputTurn?.endReason === 'AUDIO_STREAM_ENDED')
            )
              return;
            if (!inputTurn) {
              inputTurn = {
                id: captureId ?? value.turnId,
                text: '',
                mayContainSpeech: false,
                endReason: undefined,
                lastSignalAt: performance.now(),
              };
              if (whisperer) captureId = inputTurn.id;
              else captureId = undefined;
            }
            if (whisperer && mayContainSpeech(value.data)) {
              inputTurn.mayContainSpeech = true;
              // After a provider-confirmed speech boundary, only provider activity or
              // transcription updates extend the wait. Background sound can persist.
              if (inputTurn.endReason !== 'SPEECH_ACTIVITY_ENDED')
                inputTurn.lastSignalAt = performance.now();
            }
            session.sendRealtimeInput({
              audio: { data: value.data, mimeType: 'audio/pcm;rate=16000' },
            });
          } else if (value.type === 'text') {
            if (whisperer) {
              if (inputTurn?.mayContainSpeech) {
                reconnectForInput('OVERLAPPING_TEXT_INPUT');
                return;
              }
              await queue;
              if (closed || checkpointFailed) return;
            }
            await internal('checkpoint', {
              sessionId,
              eventId: value.turnId,
              turnId: value.turnId,
              role: 'user',
              text: value.text,
              final: true,
            });
            if (closed) return;
            finalUserTurnId = value.turnId;
            durableUserTurnId = value.turnId;
            session.sendClientContent({
              turns: [{ role: 'user', parts: [{ text: value.text }] }],
              turnComplete: true,
            });
          } else if (value.type === 'prepare_outline' && whisperer) {
            if (prepareTimer) clearTimeout(prepareTimer);
            prepareOutline = {
              requestId: value.requestId,
              turnId: inputTurn?.id,
              startedAt: performance.now(),
            };
            if (inputTurn) {
              const { id, mayContainSpeech } = inputTurn;
              session.sendRealtimeInput({ audioStreamEnd: true });
              if (!inputTurn.endReason) inputTurn.lastSignalAt = performance.now();
              waitForQuietInput('AUDIO_STREAM_ENDED');
              waitForInputFinal('OUTLINE_PREPARATION');
              // Unconfirmed PCM can be background noise. Give Gemini more time to
              // detect speech before releasing that tail without a transcript.
              prepareTimer = setTimeout(
                () => {
                  if (
                    prepareOutline?.requestId !== value.requestId ||
                    inputTurn?.id !== id ||
                    inputTurn.speechDetected
                  )
                    return;
                  if (mayContainSpeech) sealInput();
                  else prepareOutline.turnId = undefined;
                  notifyOutlineAfterCheckpoints();
                },
                mayContainSpeech ? unconfirmedSpeechGraceMs : inputQuietGraceMs,
              );
            }
            notifyOutlineAfterCheckpoints();
          } else if (value.type === 'resume_outline' && whisperer) {
            outlinePrepared = false;
            if (prepareTimer) clearTimeout(prepareTimer);
            prepareOutline = undefined;
            if (inputTurn?.endReason === 'AUDIO_STREAM_ENDED') inputTurn.endReason = undefined;
          } else if (value.type === 'advance_to_outline_result' && whisperer) {
            if (outline?.callId !== value.callId || !outline.sent) return;
            clearOutline();
            respondToTool(value.callId, 'advance_to_outline', value.accepted);
          } else if (value.type === 'end_audio') {
            session.sendRealtimeInput({ audioStreamEnd: true });
            if (whisperer && inputTurn) {
              if (!inputTurn.endReason) inputTurn.lastSignalAt = performance.now();
              waitForQuietInput('AUDIO_STREAM_ENDED');
              waitForInputFinal('AUDIO_STREAM_ENDED');
            }
          } else if (value.type === 'pause') socket.close(1000, 'Paused');
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
