import { condenseWhispererSeed, interview, propose, whisper } from './interviewer.js';
import { LiteraryPersonaService } from '../literary-persona.js';

const mockComplete = jest.fn();
const mockExplicitTextService = jest.fn(() => ({ complete: mockComplete }));
jest.mock('@/ai/gateway-with-tracking.js', () => ({
  getAIGatewayWithTokenTracking: () => ({
    getTextService: () => ({ complete: mockComplete }),
    getTextServiceForProvider: mockExplicitTextService,
  }),
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

it('gives the biography interviewer grounded character, setting and plot guidance', async () => {
  mockComplete.mockResolvedValue(
    JSON.stringify({ question: 'Quem queres que o livro acompanhe primeiro?' }),
  );
  try {
    await interview({
      authorId: id,
      projectId: id,
      locale: 'pt-PT',
      history: [],
      context: {},
      userText: 'Quero contar a história da equipa da minha filha.',
    });

    const { systemInstruction } = mockComplete.mock.calls[0][1];
    expect(systemInstruction).toContain(
      'ask which player or other key person it should follow first',
    );
    expect(systemInstruction).toContain('whether they played indoors or outdoors');
    expect(systemInstruction).toContain('an underdog tournament run');
    expect(systemInstruction).toContain(
      'only if the author confirms it belongs to their experience',
    );
  } finally {
    mockComplete.mockReset();
  }
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
  const inesTurns = [
    { role: 'user' as const, text: 'Quero escrever sobre a minha mulher.' },
    { role: 'assistant' as const, text: 'Como prefere chamar à sua mulher nesta história?' },
    { role: 'user' as const, text: 'Chama-se Inês. Conhecemo-nos na escola.' },
    { role: 'assistant' as const, text: 'Em que escola conheceu a Inês?' },
    { role: 'user' as const, text: 'Na Escola Secundária de Camões, em Lisboa.' },
    { role: 'assistant' as const, text: 'O que recorda dessa altura?' },
    { role: 'user' as const, text: 'Talvez em 1998. Ela emprestou-me um livro.' },
    { role: 'assistant' as const, text: 'Recorda-se de que livro era?' },
    { role: 'user' as const, text: 'O Principezinho. Tinha um bilhete lá dentro.' },
  ];
  afterEach(() => {
    mockComplete.mockReset();
    mockExplicitTextService.mockClear();
  });

  it('requires all three essentials and returns the author’s next prompt and choices', async () => {
    const areas = { characters: 'ready', setting: 'developing', plot: 'missing' };
    mockComplete.mockResolvedValue(
      JSON.stringify({
        readiness: {
          areas,
          hint: 'Conta-me o que aconteceu ao Tomás.',
          ready: true,
          rubricVersion: 1,
        },
        question: 'O que aconteceu quando o frigorífico falou?',
        choices: ['A porta abriu-se', 'O Tomás ligou a um amigo'],
        choicesMode: 'single',
      }),
    );
    await expect(whisper(input)).resolves.toEqual({
      readiness: {
        rubricVersion: 3,
        areas,
        hint: 'Conta-me o que aconteceu ao Tomás.',
        ready: false,
        missing: ['setting', 'plot'],
      },
      question: 'O que aconteceu quando o frigorífico falou?',
      choices: ['A porta abriu-se', 'O Tomás ligou a um amigo'],
      choicesMode: 'single',
    });
    expect(mockExplicitTextService).toHaveBeenCalledWith(
      'google-genai',
      { authorId: id, storyId: `biographer:${id}`, action: 'story_enhancement' },
      { allowFallback: false },
    );
    expect(mockComplete.mock.calls[0][1]).toMatchObject({
      model: 'gemini-4-hydrogen',
      privateContent: true,
      thinkingLevel: 'low',
    });
  });

  it('skips the question when the caller asks for readiness alone', async () => {
    const areas = { characters: 'ready', setting: 'ready', plot: 'ready' };
    mockComplete.mockResolvedValue(JSON.stringify({ readiness: { areas, hint: '' } }));
    await expect(whisper({ ...input, requestQuestion: false })).resolves.toEqual({
      readiness: { rubricVersion: 3, areas, hint: '', ready: true, missing: [] },
    });
  });

  it('asks the model to deepen story details and offer optional editorial choices', async () => {
    mockComplete.mockResolvedValue(
      JSON.stringify({
        readiness: { areas: { characters: 'ready', setting: 'ready', plot: 'ready' }, hint: '' },
        question: 'Como gostarias de começar?',
        choices: ['Pelo primeiro encontro', 'Pelo bilhete e depois voltar ao encontro'],
        choicesMode: 'single',
      }),
    );

    await expect(whisper({ ...input, turns: inesTurns })).resolves.toMatchObject({
      question: 'Como gostarias de começar?',
      choices: ['Pelo primeiro encontro', 'Pelo bilhete e depois voltar ao encontro'],
      choicesMode: 'single',
    });

    const { systemInstruction } = mockComplete.mock.calls[0][1];
    expect(systemInstruction).toContain(
      'ask which player or other key person it should follow first',
    );
    expect(systemInstruction).toContain('ask separately about place and time when each matters');
    expect(systemInstruction).toContain('one or more events or threads');
    expect(systemInstruction).toContain('ask what to call them');
    expect(systemInstruction).toContain('one chapter per match');
    expect(systemInstruction).toContain('each chapter could follow one or two players');
    expect(systemInstruction).toContain(
      'leave room for another approach or for the author to delegate',
    );
    expect(systemInstruction).toContain('editorial possibilities until the author chooses');
    expect(systemInstruction).toContain('an uncertain date stays uncertain');
    expect(systemInstruction).toContain('the contents of an object or message stay unknown');
  });

  it.each([
    {
      turnCount: 1,
      nextQuestion: 'Como preferes chamar-lhe nesta história?',
      areas: { characters: 'developing', setting: 'missing', plot: 'missing' },
    },
    {
      turnCount: 3,
      nextQuestion: 'Em que escola conheceste a Inês?',
      areas: { characters: 'developing', setting: 'developing', plot: 'developing' },
    },
    {
      turnCount: 5,
      nextQuestion: 'Que pequeno gesto ou momento recordas dessa altura?',
      areas: { characters: 'developing', setting: 'ready', plot: 'developing' },
    },
  ])(
    'requests a new lead with a saved prefix of $turnCount turns',
    async ({ turnCount, nextQuestion, areas }) => {
      const opening = { question: 'Sobre quem gostaria de escrever?', choices: [] };
      const turns = inesTurns.slice(0, turnCount);
      mockComplete.mockResolvedValue(
        JSON.stringify({ readiness: { areas, hint: nextQuestion }, question: nextQuestion }),
      );
      await expect(whisper({ ...input, context: { opening }, turns })).resolves.toMatchObject({
        readiness: { areas, ready: false },
        question: nextQuestion,
      });
      const [payload, { systemInstruction }] = mockComplete.mock.calls[0];
      expect(JSON.parse(payload)).toMatchObject({
        context: { opening },
        turns,
      });
      expect(systemInstruction).toContain('In pt-PT, address the author informally as “tu”');
      expect(systemInstruction).toContain('including when saved questions use a formal register');
      expect(systemInstruction).toContain('ask them directly about what they saw or did');
      expect(systemInstruction).toContain('avoid assuming they were there');
      expect(systemInstruction).toContain("does not determine the book's narrative point of view");
      expect(systemInstruction).toContain('Accept a role, alias or relationship');
      expect(systemInstruction).toContain('with a concrete action, detail or consequence');
    },
  );

  it('sends the full team-spirit thread for a follow-up and keeps the outline gated', async () => {
    const context = {
      opening: { question: 'Onde gostaria que começasse a história de amor?', choices: [] },
    };
    const turns = [
      { role: 'user' as const, text: 'Quero escrever sobre a equipa de futebol da minha filha.' },
      { role: 'assistant' as const, text: 'Que jogo ou treino se destacou?' },
      { role: 'user' as const, text: 'O espírito de equipa.' },
    ];
    const areas = { characters: 'developing', setting: 'missing', plot: 'developing' };
    const question = 'Que momento mostra melhor o espírito de equipa?';
    mockComplete.mockResolvedValue(
      JSON.stringify({ readiness: { areas, hint: question }, question }),
    );
    await expect(whisper({ ...input, context, turns })).resolves.toMatchObject({
      readiness: {
        areas,
        ready: false,
        missing: ['characters', 'setting', 'plot'],
        rubricVersion: 3,
      },
      question,
    });
    const [payload, { systemInstruction }] = mockComplete.mock.calls[0];
    expect(JSON.parse(payload)).toMatchObject({ context, turns });
    expect(systemInstruction).toContain(
      'shifts away from the initial intent, selected genre or opening',
    );
    expect(systemInstruction).toContain('move to the most useful unresolved detail');
    expect(systemInstruction).toContain('without praise, commentary on the quality of the idea');
    expect(systemInstruction).toContain('move to a gap in another area');
    expect(systemInstruction).toContain('leaves open who approached whom');
    expect(systemInstruction).toContain('point the question and hint at the same useful gap');
    expect(systemInstruction).toContain('A team name, a family relationship or a broad quality');
    expect(systemInstruction).toContain(
      'A concrete action in a scene can satisfy both characters and plot',
    );
    expect(systemInstruction).toContain('An unnamed subject can be ready');
    expect(systemInstruction).toContain(
      'delegating the distinguishing detail or character development can satisfy the area',
    );
    expect(systemInstruction).toContain(
      'Delegating a name or asking to stay anonymous does not supply a distinguishing detail',
    );
  });

  it('passes short answers with the opening and asks for one grounded, localized follow-up', async () => {
    const context = {
      primaryIntent: 'remember',
      opening: { question: 'Sobre quem gostaria de escrever?', choices: [] },
    };
    const turns = inesTurns;
    const areas = { characters: 'ready', setting: 'ready', plot: 'ready' };
    mockComplete.mockResolvedValue(
      JSON.stringify({
        readiness: { areas, hint: '' },
        question: 'Lembras-te do que dizia o bilhete?',
      }),
    );
    await expect(whisper({ ...input, turns, context })).resolves.toMatchObject({
      readiness: { areas, ready: true, missing: [] },
    });
    const [payload, { systemInstruction }] = mockComplete.mock.calls[0];
    expect(JSON.parse(payload)).toMatchObject({ locale: 'pt-PT', context, turns });
    expect(systemInstruction).toContain('do not establish details on their own');
    expect(systemInstruction).toContain('alias, role or relationship');
    expect(systemInstruction).toContain('Either where or when suffices');
    expect(systemInstruction).toContain('An explicitly delegated decision satisfies');
    expect(systemInstruction).toContain('ask one optional craft question');
  });

  it('keeps prompts paired with selections in long seeds and excludes unchosen suggestions', async () => {
    const entries = [
      { question: 'Onde aconteceu?', choices: ['Em Braga', 'No Porto'], text: 'A segunda.' },
      { question: 'Foi em 1980?', text: 'Não tenho a certeza do ano.' },
      { text: 'Chama-lhe Inês. Inventa o nome da estação.' },
    ];
    mockComplete.mockResolvedValue(JSON.stringify({ text: 'No Porto, num ano incerto.' }));
    await expect(condenseWhispererSeed({ ...input, entries, maxLength: 1000 })).resolves.toEqual({
      text: 'No Porto, num ano incerto.',
    });
    const [payload, { systemInstruction }] = mockComplete.mock.calls[0];
    expect(JSON.parse(payload)).toEqual(entries);
    expect(systemInstruction).toContain('An ordinal adopts only the selected option');
    expect(systemInstruction).toContain('Discard implied facts and unchosen suggestions');
    expect(systemInstruction).toContain('stated uncertainties');
  });

  it('sends every provided seed entry privately and rejects an oversized result', async () => {
    const entries = ['Tomás ouve um frigorífico.', 'Foi na casa da avó, numa noite de inverno.'];
    mockComplete.mockResolvedValue(JSON.stringify({ text: 'x'.repeat(1001) }));
    await expect(condenseWhispererSeed({ ...input, entries, maxLength: 1000 })).rejects.toThrow();
    expect(JSON.parse(mockComplete.mock.calls[0][0])).toEqual(entries);
    expect(mockExplicitTextService).toHaveBeenCalledWith(
      'google-genai',
      { authorId: id, storyId: `biographer:${id}`, action: 'story_structure' },
      { allowFallback: false },
    );
    expect(mockComplete.mock.calls[0][1]).toMatchObject({
      model: 'gemini-4-hydrogen',
      privateContent: true,
      thinkingLevel: 'low',
    });
  });
});
