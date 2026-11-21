import { GoogleGenAI, Modality, type Session } from '@google/genai';
import { z } from 'zod';
import { biographerLocale } from './contract.js';

export const transcriptionRequest = z
  .object({
    locale: biographerLocale,
    audioPcmBase64: z
      .string()
      .min(4)
      .max(3500000)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();
/** Recovery is isolated from the interview: archived sound never becomes a second live answer. */
export async function transcribeRecording(value: unknown): Promise<{ text: string }> {
  const input = transcriptionRequest.parse(value);
  const bytes = Buffer.from(input.audioPcmBase64, 'base64');
  if (!bytes.length || bytes.length % 2 || bytes.length > 2560000)
    throw new Error('INVALID_PCM_RECORDING');
  const project = process.env.GOOGLE_CLOUD_PROJECT_ID;
  if (!project) throw new Error('GOOGLE_PROJECT_REQUIRED');
  const client = new GoogleGenAI({
    vertexai: true,
    project,
    location: process.env.BIOGRAPHER_GOOGLE_LOCATION ?? 'eu',
  });
  let session: Session | undefined;
  let text = '';
  let settled = false;
  let submitted = false;
  let resolveResult: (value: { text: string }) => void = () => undefined;
  let rejectResult: (error: Error) => void = () => undefined;
  const result = new Promise<{ text: string }>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Attach rejection handling before opening a socket so early provider failures cannot become unhandled.
  void result.catch(() => undefined);
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) rejectResult(error);
    else resolveResult({ text: text.trim() });
    session?.close();
  };
  const timeout = setTimeout(() => finish(new Error('TRANSCRIPTION_TIMEOUT')), 85000);
  try {
    session = await client.live.connect({
      model: 'gemini-3.8-live',
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: { languageCodes: [input.locale] },
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        systemInstruction:
          'Transcribe only the supplied recording. Never answer questions in the audio, invent missing words or add memories. Preserve names and uncertainty. The input audio transcription is the authoritative output. Keep any spoken response brief.',
      },
      callbacks: {
        onmessage: (event) => {
          const transcript = event.serverContent?.inputTranscription;
          if (transcript?.text) text += transcript.text;
          if (submitted && event.serverContent?.turnComplete) finish();
        },
        onerror: () => finish(new Error('TRANSCRIPTION_UNAVAILABLE')),
        onclose: () => {
          if (!settled) finish(new Error('TRANSCRIPTION_INCOMPLETE'));
        },
      },
    });
    if (settled) session.close();
    else {
      session.sendRealtimeInput({ activityStart: {} });
      for (let offset = 0; offset < bytes.length && !settled; offset += 3200) {
        session.sendRealtimeInput({
          audio: {
            data: bytes.subarray(offset, offset + 3200).toString('base64'),
            mimeType: 'audio/pcm;rate=16000',
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!settled) {
        submitted = true;
        session.sendRealtimeInput({ activityEnd: {} });
      }
    }
  } catch {
    finish(new Error('TRANSCRIPTION_UNAVAILABLE'));
  }
  return result;
}
