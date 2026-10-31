import { z } from 'zod';
import type { ImageMetadata, DetectedCharacter } from './image-analysis.js';

export const characterReferencesSchema = z
  .array(
    z
      .object({
        questionId: z.string().trim().min(1).max(100),
        question: z.string().trim().min(1).max(300),
        answer: z.string().trim().min(1).max(1500),
        imageObjectPath: z.string().min(1).max(1024),
        sourceCharacterIndex: z.number().int().min(0).max(49),
        targetRole: z.literal('protagonist'),
      })
      .strict(),
  )
  .max(1);

export type CharacterReference = z.infer<typeof characterReferencesSchema>[number];
export type ReferenceImageMetadata = ImageMetadata & { path: string };

export function refineCharacterReferenceInput(
  input: {
    characterReferences?: CharacterReference[] | undefined;
    imageObjectPaths?: string[] | undefined;
    locale?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (!input.characterReferences?.length) return;
  if (input.locale !== 'pt-PT')
    context.addIssue({ code: 'custom', path: ['locale'], message: 'Photo answers require pt-PT' });
  if (
    input.characterReferences.some(
      (reference) => !input.imageObjectPaths?.includes(reference.imageObjectPath),
    )
  )
    context.addIssue({
      code: 'custom',
      path: ['characterReferences'],
      message: 'Character reference must be a submitted image',
    });
}

export const CHARACTER_REFERENCE_INSTRUCTION =
  'Confirmed character photographs are visual likeness references only. Use only the selected person or animal for the protagonist, preserving their visible appearance in illustrations. Backgrounds, OCR, other people and estimated ages are not evidence of events, identity, relationships, dates or biography. Never use these original photographs as cover or background references. Do not infer personal facts from a photograph.';

/** Resolve against server metadata after ownership-checked relocation, never client descriptions. */
export function resolveCharacterReferences(
  references: CharacterReference[],
  originalPaths: string[],
  relocatedPaths: string[],
  imageMetas: ReferenceImageMetadata[],
): Array<CharacterReference & { detected: DetectedCharacter }> {
  if (!references.length) return [];
  if (new Set(originalPaths).size !== originalPaths.length)
    throw new Error('Duplicate image inputs cannot be used as character references');
  return references.map((reference) => {
    const position = originalPaths.indexOf(reference.imageObjectPath);
    const path = position >= 0 ? relocatedPaths[position] : undefined;
    if (!path) throw new Error('Character reference must be a submitted image');
    const metadata = imageMetas.find((image) => image.path === path);
    const detected = metadata?.characters[reference.sourceCharacterIndex];
    const box = detected?.box_2d;
    if (
      metadata?.overallImageContent !== 'photo' ||
      !detected?.physicalDescription.trim() ||
      !detected.type.trim() ||
      !box ||
      box.length !== 4 ||
      box.some((value) => !Number.isFinite(value) || value < 0 || value > 1000) ||
      box[0] >= box[2] ||
      box[1] >= box[3]
    )
      throw new Error('Character reference must select a detected person or animal in a photo');
    return { ...reference, imageObjectPath: path, detected };
  });
}

/** A role match must be unique: never guess by array order, name or apparent age. */
export function bindCharacterReference(
  characters: Array<Record<string, any>>,
  reference: CharacterReference & { detected: DetectedCharacter },
): Record<string, any> {
  const protagonists = characters.filter((character) => character.role === reference.targetRole);
  const protagonist = protagonists[0];
  if (protagonists.length !== 1 || !protagonist)
    throw new Error('The selected photograph could not be linked to one protagonist');
  for (const character of characters) {
    if (character.sourceImagePath === reference.imageObjectPath) {
      character.sourceImagePath = null;
      character.sourceCharacterIndex = null;
    }
  }
  // New confirmed references must never overwrite an existing library character's photo.
  protagonist.characterId = null;
  protagonist.sourceImagePath = reference.imageObjectPath;
  protagonist.sourceCharacterIndex = reference.sourceCharacterIndex;
  protagonist.physicalDescription = reference.detected.physicalDescription;
  const detectedKind = reference.detected.type.toLowerCase().trim();
  const canonicalKinds: Record<string, string> = {
    human: 'person',
    child: 'person',
    person: 'person',
    man: 'man',
    woman: 'woman',
    boy: 'boy',
    girl: 'girl',
    dog: 'dog',
    cat: 'cat',
    bird: 'bird',
    animal: 'other_animal',
    other_animal: 'other_animal',
  };
  if (Object.hasOwn(canonicalKinds, detectedKind)) protagonist.type = canonicalKinds[detectedKind];
  return protagonist;
}
