import { OutlineSchema } from '@/routes/ai.js';

const baseOutline = {
  bookTitle: 'Test Title',
  'target-audience': 'children_7-10',
  bookCoverPrompt: 'A vibrant cover showing the hero.',
  bookBackCoverPrompt: 'A matching back cover scene.',
  synopses: 'An engaging synopsis.',
  characters: [
    {
      name: 'Hero',
      type: 'boy',
      role: 'protagonist',
      age: 'school_age',
      traits: ['brave'],
      characteristics: 'Curious and brave',
      physicalDescription: 'Short brown hair, blue eyes',
    },
  ],
  chapters: [
    {
      chapterNumber: 1,
      chapterTitle: 'Start',
      chapterSynopses: 'Opening of the adventure.',
      chapterPhotoPrompt: 'Hero begins the journey.',
    },
  ],
};

describe('OutlineSchema validation', () => {
  it('rejects empty cover prompts', () => {
    const invalid = {
      ...baseOutline,
      bookCoverPrompt: '   ',
      bookBackCoverPrompt: '',
    };

    expect(() => OutlineSchema.parse(invalid)).toThrow();
  });

  it('accepts filled cover prompts', () => {
    expect(() => OutlineSchema.parse(baseOutline)).not.toThrow();
  });
});
