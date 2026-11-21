import { condenseWhispererSeed, propose, whisper } from './interviewer.js';
import { LiteraryPersonaService } from '../literary-persona.js';

const mockComplete = jest.fn();
jest.mock('@/ai/gateway-with-tracking.js', () => ({
  getAIGatewayWithTokenTracking: () => ({ getTextService: () => ({ complete: mockComplete }) }),
}));

const id = '11111111-1111-4111-8111-111111111111';

describe('Biographer proposal', () => {
  beforeEach(() => {
    jest.spyOn(LiteraryPersonaService, 'getPersona').mockResolvedValue({} as never);
    jest.spyOn(LiteraryPersonaService, 'buildGuidance').mockResolvedValue('Use memories.');
    mockComplete.mockResolvedValue(
      JSON.stringify({
        title: 'A memory',
        synopsis: 'A story',
        targetWords: 1000,
        omittedSources: [],
        chapters: [{ number: 1, title: 'A chapter', synopsis: 'A memory', sourceTurnIds: [id] }],
      }),
    );
  });
  afterEach(() => {
    jest.restoreAllMocks();
    mockComplete.mockReset();
  });

  it('proposes from memories without a place or external research', async () => {
    const result = await propose({
      authorId: id,
      projectId: id,
      locale: 'en-US',
      history: [],
      context: {},
      turns: [{ id, role: 'user', text: 'A treasured memory.' }],
      targetWords: 1000,
    });
    expect(result.research).toEqual([]);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(mockComplete.mock.calls[0][1].systemInstruction).toContain(
      'do not invent historical facts or sources',
    );
  });
});

describe('Story Whisperer', () => {
  const input = {
    authorId: id,
    projectId: id,
    locale: 'pt-PT' as const,
    turns: [{ role: 'user' as const, text: 'O frigorífico do Tomás falava.' }],
    photos: [],
    requestQuestion: true,
  };
  afterEach(() => mockComplete.mockReset());

  it('requires all three essentials and returns the author’s next prompt and choices', async () => {
    const areas = { characters: 'ready', setting: 'developing', plot: 'missing' };
    mockComplete.mockResolvedValue(
      JSON.stringify({
        readiness: { areas, hint: 'Conta-me o que aconteceu ao Tomás.', ready: true },
        question: 'O que aconteceu quando o frigorífico falou?',
        choices: ['A porta abriu-se', 'O Tomás ligou a um amigo'],
        choicesMode: 'single',
      }),
    );
    await expect(whisper(input)).resolves.toEqual({
      readiness: {
        areas,
        hint: 'Conta-me o que aconteceu ao Tomás.',
        ready: false,
        missing: ['setting', 'plot'],
      },
      question: 'O que aconteceu quando o frigorífico falou?',
      choices: ['A porta abriu-se', 'O Tomás ligou a um amigo'],
      choicesMode: 'single',
    });
    expect(mockComplete.mock.calls[0][1]).toMatchObject({ privateContent: true });
  });

  it('skips the question when the caller asks for readiness alone', async () => {
    const areas = { characters: 'ready', setting: 'ready', plot: 'ready' };
    mockComplete.mockResolvedValue(JSON.stringify({ readiness: { areas, hint: '' } }));
    await expect(whisper({ ...input, requestQuestion: false })).resolves.toEqual({
      readiness: { areas, hint: '', ready: true, missing: [] },
    });
  });

  it('sends every provided seed entry privately and rejects an oversized result', async () => {
    const entries = ['Tomás ouve um frigorífico.', 'Foi na casa da avó, numa noite de inverno.'];
    mockComplete.mockResolvedValue(JSON.stringify({ text: 'x'.repeat(1001) }));
    await expect(condenseWhispererSeed({ ...input, entries, maxLength: 1000 })).rejects.toThrow();
    expect(JSON.parse(mockComplete.mock.calls[0][0])).toEqual(entries);
    expect(mockComplete.mock.calls[0][1]).toMatchObject({ privateContent: true });
  });
});
