import { generateStoryStructure } from '@/services/story-structure.js';

const mockComplete = jest.fn();
const mockGetStoryContext = jest.fn();
const mockCreateCharacter = jest.fn();
const mockPhoto = jest.fn();
const mockLink = jest.fn();
const mockUpdate = jest.fn();
const mockUpload = jest.fn();
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
jest.mock('@/services/prompt.js', () => ({
  PromptService: {
    loadPrompt: jest.fn(async () => ({})),
    buildParts: (_template: unknown, variables: unknown) => ({
      systemInstruction: 'structure',
      userPrompt: JSON.stringify(variables),
    }),
    buildPrompt: (_template: unknown, variables: unknown) => JSON.stringify(variables),
  },
}));
jest.mock('@/services/schema.js', () => ({ SchemaService: { loadSchema: async () => ({}) } }));
jest.mock('@/ai/gateway-with-tracking.js', () => ({
  getAIGatewayWithTokenTracking: () => ({ getTextService: () => ({ complete: mockComplete }) }),
}));
jest.mock('@/services/storage-singleton.js', () => ({
  getStorageService: () => ({
    downloadFileAsBuffer: mockDownload,
    fileExists: async () => false,
    uploadFile: mockUpload,
  }),
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
});
