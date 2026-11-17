import { propose } from './interviewer.js';
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
