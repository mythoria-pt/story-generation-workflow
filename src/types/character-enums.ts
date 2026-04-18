// Character role options
export const CHARACTER_ROLES = [
  'protagonist',
  'antagonist',
  'companion',
  'mentor',
  'side_character',
  'narrator',
] as const;

// Character age options
export const CHARACTER_AGES = [
  'baby',
  'toddler',
  'child',
  'teen',
  'young_adult',
  'adult',
  'elderly',
  'ageless',
] as const;

// Character trait options (for the traits array)
export const CHARACTER_TRAITS = [
  'brave',
  'kind',
  'clever',
  'funny',
  'shy',
  'curious',
  'loyal',
  'adventurous',
  'creative',
  'determined',
  'cheerful',
  'mysterious',
  'wise',
  'rebellious',
  'caring',
  'ambitious',
  'patient',
  'energetic',
  'thoughtful',
  'protective',
] as const;

// Type exports for TypeScript
export type CharacterRole = (typeof CHARACTER_ROLES)[number];
export type CharacterAge = (typeof CHARACTER_AGES)[number];
export type CharacterTrait = (typeof CHARACTER_TRAITS)[number];
