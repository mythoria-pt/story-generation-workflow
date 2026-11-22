import type { LiveServerMessage } from '@google/genai';
const mockConnect = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn(() => ({ live: { connect: mockConnect } })),
  Modality: { AUDIO: 'AUDIO' },
}));
import { transcribeRecording, transcriptionRequest } from './transcribe.js';
describe('archived audio transcription', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GOOGLE_CLOUD_PROJECT_ID = 'test-project';
  });
  it('keeps interim clauses until the submitted recording finishes', async () => {
    let receive: (message: LiveServerMessage) => void = () => undefined;
    const close = jest.fn();
    const send = jest.fn((message) => {
      if (message.audio)
        receive({
          serverContent: { inputTranscription: { text: 'The map was wrong. ', finished: true } },
        } as LiveServerMessage);
      if (message.activityEnd)
        receive({
          serverContent: {
            inputTranscription: { text: 'We found a café.', finished: true },
            turnComplete: true,
          },
        } as LiveServerMessage);
    });
    mockConnect.mockImplementation(async ({ callbacks }) => {
      receive = callbacks.onmessage;
      return { sendRealtimeInput: send, close };
    });
    await expect(
      transcribeRecording({
        locale: 'en-US',
        audioPcmBase64: Buffer.alloc(3200).toString('base64'),
      }),
    ).resolves.toEqual({ text: 'The map was wrong. We found a café.' });
    expect(send.mock.calls[0]?.[0]).toEqual({ activityStart: {} });
    expect(close).toHaveBeenCalled();
    expect(mockConnect.mock.calls[0]?.[0].model).toBe('gemini-3.8-live');
    expect(mockConnect.mock.calls[0]?.[0].config.responseModalities).toEqual(['AUDIO']);
  });
  it('does not turn a closed incomplete recording into a completed answer', async () => {
    mockConnect.mockImplementation(async ({ callbacks }) => {
      callbacks.onclose();
      return { close: jest.fn(), sendRealtimeInput: jest.fn() };
    });
    await expect(transcribeRecording({ locale: 'pt-PT', audioPcmBase64: 'AAA=' })).rejects.toThrow(
      'TRANSCRIPTION_INCOMPLETE',
    );
  });
  it('rejects malformed and oversized source data', async () => {
    expect(
      transcriptionRequest.safeParse({ locale: 'en-US', audioPcmBase64: 'not base64' }).success,
    ).toBe(false);
    await expect(transcribeRecording({ locale: 'en-US', audioPcmBase64: 'AA==' })).rejects.toThrow(
      'INVALID_PCM_RECORDING',
    );
  });
});
