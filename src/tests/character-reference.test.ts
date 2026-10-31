import {
  bindCharacterReference,
  characterReferencesSchema,
  resolveCharacterReferences,
  refineCharacterReferenceInput,
} from '@/services/character-reference.js';
import { z } from 'zod';

const reference = {
  questionId: 'hero',
  question: 'Who is the protagonist?',
  answer: 'The selected person in my photograph',
  imageObjectPath: 'author/inputs/photo.jpg',
  sourceCharacterIndex: 1,
  targetRole: 'protagonist' as const,
};
const detected = {
  label: 'dog_1',
  type: 'dog',
  physicalDescription: 'A small brown dog with white ears',
  box_2d: [10, 20, 900, 800] as [number, number, number, number],
};
const metadata = {
  path: 'story/inputs/photo.jpg',
  overallImageContent: 'photo' as const,
  description: 'A private birthday party',
  text: 'A private date',
  characters: [{ ...detected, physicalDescription: 'Unselected subject' }, detected],
};

describe('confirmed character photo contract', () => {
  it('keeps one explicit selected-subject association through relocation', () => {
    expect(
      resolveCharacterReferences(
        characterReferencesSchema.parse([reference]),
        [reference.imageObjectPath],
        [metadata.path],
        [metadata],
      ),
    ).toEqual([{ ...reference, imageObjectPath: metadata.path, detected }]);
  });
  it('rejects multiple protagonists, fractional indexes and unsubmitted paths', () => {
    expect(characterReferencesSchema.safeParse([reference, reference]).success).toBe(false);
    expect(
      characterReferencesSchema.safeParse([{ ...reference, sourceCharacterIndex: 0.5 }]).success,
    ).toBe(false);
    expect(() => resolveCharacterReferences([reference], [], [], [metadata])).toThrow('submitted');
  });
  it('requires the pt-PT locale and a submitted path at both route boundaries', () => {
    const input = z
      .object({
        locale: z.string().optional(),
        imageObjectPaths: z.array(z.string()).optional(),
        characterReferences: characterReferencesSchema.optional(),
      })
      .superRefine(refineCharacterReferenceInput);
    expect(
      input.safeParse({
        locale: 'en-US',
        imageObjectPaths: [reference.imageObjectPath],
        characterReferences: [reference],
      }).success,
    ).toBe(false);
    expect(input.safeParse({ locale: 'pt-PT', characterReferences: [reference] }).success).toBe(
      false,
    );
    expect(
      input.safeParse({
        locale: 'pt-PT',
        imageObjectPaths: [reference.imageObjectPath],
        characterReferences: [reference],
      }).success,
    ).toBe(true);
    expect(input.safeParse({ locale: 'en-US' }).success).toBe(true);
  });
  it.each([
    { ...metadata, overallImageContent: 'drawing' as const },
    { ...metadata, characters: [] },
    {
      ...metadata,
      characters: [detected, { ...detected, box_2d: [0, NaN, 100, 100] as typeof detected.box_2d }],
    },
    {
      ...metadata,
      characters: [detected, { ...detected, box_2d: [900, 20, 10, 800] as typeof detected.box_2d }],
    },
  ])('rejects an unavailable or non-photo subject rather than guessing', (invalidMetadata) => {
    expect(() =>
      resolveCharacterReferences(
        [reference],
        [reference.imageObjectPath],
        [metadata.path],
        [invalidMetadata],
      ),
    ).toThrow('detected person or animal');
  });
  it('binds by unique explicit role and prevents model links to other characters or library updates', () => {
    const resolved = { ...reference, imageObjectPath: metadata.path, detected };
    const other = { role: 'sidekick', sourceImagePath: metadata.path, sourceCharacterIndex: 0 };
    const hero = {
      role: 'protagonist',
      characterId: 'saved-character',
      physicalDescription: 'wrong',
    };
    expect(bindCharacterReference([other, hero], resolved)).toBe(hero);
    expect(hero).toMatchObject({
      characterId: null,
      physicalDescription: detected.physicalDescription,
      sourceImagePath: metadata.path,
      sourceCharacterIndex: 1,
    });
    expect(other).toMatchObject({ sourceImagePath: null, sourceCharacterIndex: null });
    expect(() => bindCharacterReference([other], resolved)).toThrow('one protagonist');
    expect(() => bindCharacterReference([hero, { ...hero }], resolved)).toThrow('one protagonist');
  });
});
