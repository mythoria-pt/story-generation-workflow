import { generateStoryStructure } from '@/services/story-structure.js';

const mockComplete = jest.fn();
const mockExplicitTextService = jest.fn((..._args: unknown[]) => ({ complete: mockComplete }));
const mockGetStoryContext = jest.fn();
const mockCreateCharacter = jest.fn();
const mockPhoto = jest.fn();
const mockLink = jest.fn();
const mockUpdate = jest.fn();
const mockDraftLockQuery = jest.fn();
const mockUpload = jest.fn();
const mockPrivateUpload = jest.fn();
const mockDownload = jest.fn();
const mockMetadata = jest.fn();
const mockCrop = jest.fn();
const mockGetCharacters = jest.fn();
jest.mock('@/services/structure-lock.js', () => ({
  withStructureLock: (_id: string, work: (signal: AbortSignal) => unknown) =>
    work(new AbortController().signal),
}));
jest.mock('@/services/structure-inputs.js', () => ({
  relocateStructureInput: async (
    _storage: unknown,
    storyId: string,
    _author: string,
    path: string,
  ) => `${storyId}/inputs/${path.split('/').pop()}`,
}));
jest.mock('@/services/story.js', () => ({
  StoryService: jest.fn(() => ({
    getStoryContext: (...args: unknown[]) => mockGetStoryContext(...args),
  })),
}));
jest.mock('@/services/characters.js', () => ({
  CharacterService: jest.fn(() => ({
    createCharacter: (...args: unknown[]) => mockCreateCharacter(...args),
    updateCharacterPhoto: (...args: unknown[]) => mockPhoto(...args),
    addCharacterToStory: (...args: unknown[]) => mockLink(...args),
    getCharacterById: (...args: unknown[]) => mockGetCharacters(...args),
  })),
}));
jest.mock('@/ai/gateway-with-tracking.js', () => ({
  getAIGatewayWithTokenTracking: () => ({
    getTextService: () => ({ complete: mockComplete }),
    getTextServiceForProvider: (...args: unknown[]) => mockExplicitTextService(...args),
  }),
}));
jest.mock('@/services/storage-singleton.js', () => ({
  getStorageService: () => ({
    downloadFileAsBuffer: mockDownload,
    fileExists: async () => false,
    uploadFile: mockUpload,
  }),
}));
jest.mock('@/services/storage.js', () => ({
  StorageService: jest.fn(() => ({ uploadFile: mockPrivateUpload })),
}));
jest.mock('@/services/image-analysis.js', () => ({
  loadOrAnalyzeMetadata: (...args: unknown[]) => mockMetadata(...args),
  metadataPathFor: (path: string) => path.replace(/\.jpg$/, '.json'),
}));
jest.mock('@/utils/imageProcessing.js', () => ({
  cropToJpeg: (...args: unknown[]) => mockCrop(...args),
}));
jest.mock('@/db/connection.js', () => ({
  getDatabase: () => ({
    update: () => ({ set: (updates: unknown) => ({ where: () => mockUpdate(updates) }) }),
    transaction: (action: (tx: unknown) => unknown) => action({ execute: mockDraftLockQuery }),
  }),
}));

const imageObjectPath = 'author/inputs/photo.jpg';
const relocatedPath = 'story/inputs/photo.jpg';
const reference = {
  questionId: 'hero',
  question: 'Quem é o protagonista?',
  answer: 'A pessoa selecionada nesta fotografia',
  imageObjectPath,
  sourceCharacterIndex: 1,
  targetRole: 'protagonist' as const,
};
const selected = {
  label: 'person_2',
  type: 'person',
  physicalDescription: 'Selected person with curly brown hair',
  box_2d: [100, 500, 900, 900],
};
const metadata = {
  overallImageContent: 'photo',
  description: 'Secret birthday background',
  text: 'Private OCR date',
  characters: [
    { ...selected, physicalDescription: 'Unselected person', box_2d: [100, 10, 900, 450] },
    selected,
  ],
};
const response = (roles = ['sidekick', 'protagonist']) => ({
  story: { title: 'A story', coverReferenceImages: [relocatedPath] },
  characters: roles.map((role, index) => ({
    name: `Person ${index}`,
    type: 'person',
    role,
    characterId: 'e9428e21-4f9c-4d3e-8c3b-e49f9a528c21',
    physicalDescription: 'Invented appearance',
    sourceImagePath: relocatedPath,
    sourceCharacterIndex: 0,
  })),
});
const params = {
  storyId: 'story',
  locale: 'pt-PT',
  userDescription: 'Author supplied memory',
  imageObjectPaths: [imageObjectPath],
  characterReferences: [reference],
  factuality: 'memory' as const,
};

describe('story structure confirmed protagonist reference', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEXT_PROVIDER = 'google-genai';
    mockDraftLockQuery.mockResolvedValue({ rows: [{ active: true }] });
    mockGetStoryContext.mockResolvedValue({ story: { authorId: 'author' } });
    mockMetadata.mockResolvedValue(metadata);
    mockDownload.mockResolvedValue(Buffer.from('original photo'));
    mockCrop.mockResolvedValue(Buffer.from('selected crop'));
    mockUpload.mockResolvedValue('https://example.test/crop.jpg');
    mockGetCharacters.mockResolvedValue(null);
    mockCreateCharacter.mockImplementation(async (input) => ({
      ...input,
      characterId: input.name === 'Person 1' ? 'hero-id' : 'other-id',
      photoUrl: null,
    }));
    mockPhoto.mockResolvedValue({ characterId: 'hero-id' });
    mockLink.mockResolvedValue({});
    mockUpdate.mockResolvedValue(undefined);
    mockComplete.mockResolvedValue(JSON.stringify(response()));
  });
  it('uses only selected appearance, crops the correct subject and excludes the original from covers', async () => {
    const result = await generateStoryStructure(params);
    const prompt = mockComplete.mock.calls[0][0];
    expect(prompt).toContain(selected.physicalDescription);
    expect(prompt).not.toContain('Secret birthday');
    expect(prompt).not.toContain('Private OCR');
    expect(prompt).not.toContain('Unselected person');
    expect(mockComplete.mock.calls[0][1].privateContent).toBe(true);
    expect(mockExplicitTextService).not.toHaveBeenCalled();
    expect(mockCrop).toHaveBeenCalledTimes(1);
    expect(mockCrop).toHaveBeenCalledWith(Buffer.from('original photo'), selected.box_2d);
    expect(mockPhoto).toHaveBeenCalledWith(
      'hero-id',
      expect.stringMatching(/^author\/characters\/hero-id\/.+\.jpg$/),
      expect.stringMatching(/^author\/characters\/hero-id\/.+\.jpg$/),
    );
    expect(mockLink).toHaveBeenCalledWith('story', 'hero-id', 'protagonist');
    expect(result.story.coverReferenceUris).toBeNull();
    expect(result.characters[1]).toMatchObject({
      physicalDescription: selected.physicalDescription,
    });
    const snapshot = mockUpload.mock.calls.find((call) => call[0] === 'story/inputs/manifest.json');
    expect(JSON.parse(snapshot[1].toString()).characterReferences).toEqual([
      { ...reference, imageObjectPath: relocatedPath },
    ]);
  });
  it.each([{ roles: [] }, { roles: ['protagonist', 'protagonist'] }])(
    'fails before persistence for ambiguous/missing protagonist $roles',
    async ({ roles }) => {
      mockComplete.mockResolvedValue(JSON.stringify(response(roles)));
      await expect(generateStoryStructure(params)).rejects.toThrow('one protagonist');
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockCreateCharacter).not.toHaveBeenCalled();
    },
  );
  it('fails before a model call if the selected photo subject is unavailable', async () => {
    mockMetadata.mockResolvedValue({ ...metadata, characters: [] });
    await expect(generateStoryStructure(params)).rejects.toThrow('could not be prepared');
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
  it('surfaces crop and photo persistence failures instead of silently generating without likeness', async () => {
    mockCrop.mockRejectedValueOnce(new Error('bad crop'));
    await expect(generateStoryStructure(params)).rejects.toThrow('could not be prepared');
    expect(mockComplete).not.toHaveBeenCalled();
    mockPhoto.mockRejectedValueOnce(new Error('photo save failed'));
    await expect(generateStoryStructure(params)).rejects.toThrow('photograph could not be saved');
  });
  it('keeps legacy general image metadata and cover reference behavior without explicit references', async () => {
    const { characterReferences: _references, ...legacy } = params;
    expect(_references).toEqual([reference]);
    const result = await generateStoryStructure(legacy);
    expect(mockComplete.mock.calls[0][0]).toContain('Secret birthday background');
    expect(result.story.coverReferenceUris).toEqual([
      expect.stringContaining('story/inputs/photo.jpg'),
    ]);
  });
  it('uses private Whisperer assets without storing originals, crops or interview text in ordinary storage', async () => {
    const previousBucket = process.env.BIOGRAPHER_STORAGE_BUCKET;
    const previousTextProvider = process.env.TEXT_PROVIDER;
    process.env.BIOGRAPHER_STORAGE_BUCKET = 'whisperer-private-test';
    process.env.TEXT_PROVIDER = 'openai';
    const structureRequestId = '0621c74a-fb9f-82ec-9a40-2d481fd931ef';
    const photoId = '551300fc-5a34-4735-b9f3-3f770e12ff06';
    const path = `story/inputs/whisperer-${structureRequestId}-${photoId}.jpg`;
    mockComplete.mockResolvedValue(JSON.stringify(response()));
    try {
      const result = await generateStoryStructure({
        storyId: 'story',
        userDescription: 'Interview notes',
        storyWhisperer: true,
        structureRequestId,
        imageObjectPaths: [path],
      });
      expect(mockMetadata).toHaveBeenCalledWith(path, 'en-US', {
        authorId: 'author',
        privateContent: true,
        storage: expect.objectContaining({ uploadFile: mockPrivateUpload }),
        accessPrivateInput: expect.any(Function),
      });
      const [prompt, options] = mockComplete.mock.calls[0];
      expect(mockExplicitTextService).toHaveBeenCalledWith(
        'google-genai',
        { authorId: 'author', storyId: 'story', action: 'story_structure' },
        { allowFallback: false },
      );
      expect(options).toMatchObject({
        model: 'gemini-4-hydrogen',
        privateContent: true,
        thinkingLevel: 'high',
      });
      expect(prompt).not.toContain('Secret birthday');
      expect(prompt).not.toContain('Private OCR');
      expect(mockCrop).not.toHaveBeenCalled();
      expect(mockUpload).not.toHaveBeenCalled();
      expect(mockPrivateUpload).toHaveBeenCalledWith(
        `story/inputs/whisperer-${structureRequestId}-description.txt`,
        expect.any(Buffer),
        'text/plain; charset=utf-8',
      );
      expect(result.story.coverReferenceUris).toEqual([`gs://whisperer-private-test/${path}`]);
      expect(result.originalInput).toBe('');
      mockPrivateUpload.mockClear();
      mockDraftLockQuery.mockResolvedValue({ rows: [] });
      const metadataWrite = jest.fn();
      await mockMetadata.mock.calls[0][2].accessPrivateInput(metadataWrite);
      expect(metadataWrite).not.toHaveBeenCalled();
      await generateStoryStructure({
        storyId: 'story',
        userDescription: 'Interview notes',
        storyWhisperer: true,
        structureRequestId,
      });
      expect(mockPrivateUpload).not.toHaveBeenCalled();
    } finally {
      if (previousTextProvider === undefined) delete process.env.TEXT_PROVIDER;
      else process.env.TEXT_PROVIDER = previousTextProvider;
      if (previousBucket === undefined) delete process.env.BIOGRAPHER_STORAGE_BUCKET;
      else process.env.BIOGRAPHER_STORAGE_BUCKET = previousBucket;
    }
  });

  it('builds the Step 4 story from the paired interview brief and stores the source privately', async () => {
    const previousBucket = process.env.BIOGRAPHER_STORAGE_BUCKET;
    process.env.BIOGRAPHER_STORAGE_BUCKET = 'whisperer-private-test';
    const structureRequestId = '0621c74a-fb9f-82ec-9a40-2d481fd931ef';
    const source = [
      {
        interviewerQuestion: 'Sobre quem gostaria de escrever?',
        interviewerChoices: ['Sobre alguém importante', 'Sobre mim'],
        authorReply: 'Quero escrever sobre a minha mulher.',
      },
      {
        interviewerQuestion: 'Como prefere chamar-lhe nesta história?',
        authorReply: 'Chama-se Inês. Conhecemo-nos na escola.',
      },
      {
        interviewerQuestion: 'Em que escola conheceu a Inês?',
        authorReply: 'Na Escola Secundária de Camões, em Lisboa.',
      },
      {
        interviewerQuestion: 'Que momento recorda dessa altura?',
        authorReply: 'Talvez em 1998. Ela emprestou-me um livro.',
      },
      {
        interviewerQuestion: 'Recorda-se de que livro era?',
        authorReply: 'O Principezinho. Tinha um bilhete lá dentro.',
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n\n');
    const unansweredQuestion = 'Recorda-se do que dizia o bilhete?';
    const plotDescription =
      'Na Escola Secundária de Camões, em Lisboa, talvez em 1998, Inês empresta O Principezinho à pessoa que viria a casar consigo. Dentro do livro havia um bilhete.';
    const synopsis = 'Uma recordação de como o autor conheceu Inês, centrada num livro emprestado.';
    mockComplete.mockResolvedValue(
      JSON.stringify({
        story: { title: 'O bilhete no livro', plotDescription, synopsis, storyLanguage: 'pt-PT' },
        characters: [
          { name: 'Inês', type: 'person', role: 'protagonist' },
          { name: 'Pessoa que narra', type: 'person', role: 'narrator' },
        ],
      }),
    );
    mockCreateCharacter.mockImplementation(async (input) => ({
      ...input,
      characterId: input.name === 'Inês' ? 'ines-id' : 'narrator-id',
    }));

    try {
      const result = await generateStoryStructure({
        storyId: 'story',
        locale: 'pt-PT',
        userDescription: source,
        factuality: 'memory',
        storyWhisperer: true,
        structureRequestId,
      });

      expect(mockComplete).toHaveBeenCalledTimes(1);
      const [prompt, options] = mockComplete.mock.calls[0];
      expect(prompt).toContain(source);
      expect(prompt).not.toContain(unansweredQuestion);
      expect(options.privateContent).toBe(true);
      expect(options.systemInstruction).toContain('Preserve only user-supplied real facts');
      expect(options.systemInstruction).toContain('an approximate date stays approximate');
      expect(options.systemInstruction).toContain('the contents of a note) remains open');
      expect(options.systemInstruction).toContain(
        'interviewerChoices supply context for authorReply',
      );

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ plotDescription, synopsis, storyLanguage: 'pt-PT' }),
      );
      expect(mockLink).toHaveBeenCalledWith('story', 'ines-id', 'protagonist');
      expect(mockLink).toHaveBeenCalledWith('story', 'narrator-id', 'narrator');
      expect(result.story).toMatchObject({ plotDescription, synopsis, storyLanguage: 'pt-PT' });
      expect(result.characters).toEqual([
        expect.objectContaining({ characterId: 'ines-id', name: 'Inês', role: 'protagonist' }),
        expect.objectContaining({
          characterId: 'narrator-id',
          name: 'Pessoa que narra',
          role: 'narrator',
        }),
      ]);
      expect(result.originalInput).toBe('');
      expect(mockUpload).not.toHaveBeenCalled();
      const prefix = `story/inputs/whisperer-${structureRequestId}-`;
      const snapshots = new Map<string, Buffer>(mockPrivateUpload.mock.calls);
      expect(snapshots.get(`${prefix}description.txt`)?.toString('utf8')).toContain(source);
      const manifest = snapshots.get(`${prefix}manifest.json`);
      expect(JSON.parse(manifest!.toString('utf8'))).toMatchObject({
        userDescription: expect.stringContaining(source),
        locale: 'pt-PT',
      });
    } finally {
      if (previousBucket === undefined) delete process.env.BIOGRAPHER_STORAGE_BUCKET;
      else process.env.BIOGRAPHER_STORAGE_BUCKET = previousBucket;
    }
  });

  it('rejects reserved paths for ordinary jobs and other story or handoff scopes', async () => {
    const requestId = '0621c74a-fb9f-82ec-9a40-2d481fd931ef';
    const photoId = '551300fc-5a34-4735-b9f3-3f770e12ff06';
    const file = `whisperer-${requestId}-${photoId}.jpg`;
    await expect(
      generateStoryStructure({
        storyId: 'story',
        imageObjectPaths: [`story/inputs/${file}`],
      }),
    ).rejects.toThrow('Invalid Story Whisperer photo input');
    await expect(
      generateStoryStructure({
        storyId: 'story',
        storyWhisperer: true,
        structureRequestId: requestId,
        imageObjectPaths: [`another-story/inputs/${file}`],
      }),
    ).rejects.toThrow('Invalid Story Whisperer photo input');
    await expect(
      generateStoryStructure({
        storyId: 'story',
        storyWhisperer: true,
        structureRequestId: photoId,
        imageObjectPaths: [`story/inputs/${file}`],
      }),
    ).rejects.toThrow('Invalid Story Whisperer photo input');
    expect(mockMetadata).not.toHaveBeenCalled();
  });
});
