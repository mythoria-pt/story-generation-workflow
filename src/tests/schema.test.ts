/**
 * Story Outline Schema Tests
 * Tests for validating story outline JSON schema
 */

import { describe, test, expect } from '@jest/globals';
import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  CHARACTER_TYPES,
  CHARACTER_ROLES,
  CHARACTER_AGES,
  CHARACTER_TRAITS,
} from '@/shared/character-constants.js';

describe('Story Outline Schema', () => {
  test('should load story outline schema file', async () => {
    const schemaPath = join(process.cwd(), 'src', 'prompts', 'schemas', 'story-outline.json');
    const schemaContent = await readFile(schemaPath, 'utf-8');
    const schema = JSON.parse(schemaContent);

    expect(schema).toBeDefined();
    expect(typeof schema).toBe('object');
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('bookTitle');
    expect(schema.required).toContain('chapters');
    expect(schema.required).toContain('bookCoverCharacters');
    expect(schema.required).toContain('bookBackCoverCharacters');
    expect(schema.properties).toBeDefined();
    expect(schema.properties.bookTitle).toBeDefined();
    expect(schema.properties.chapters).toBeDefined();
  });

  test('should have correct chapter schema structure', async () => {
    const schemaPath = join(process.cwd(), 'src', 'prompts', 'schemas', 'story-outline.json');
    const schemaContent = await readFile(schemaPath, 'utf-8');
    const schema = JSON.parse(schemaContent);

    const chaptersSchema = schema.properties.chapters;
    expect(chaptersSchema.type).toBe('array');
    expect(chaptersSchema.items).toBeDefined();
    expect(chaptersSchema.items.type).toBe('object');
    expect(chaptersSchema.items.required).toContain('chapterNumber');
    expect(chaptersSchema.items.required).toContain('chapterTitle');
    expect(chaptersSchema.items.required).toContain('chapterSynopses');
    expect(chaptersSchema.items.required).toContain('chapterPhotoPrompt');
    expect(chaptersSchema.items.required).toContain('charactersInScene');
  });

  test('should validate basic story outline structure', () => {
    const validOutline = {
      bookTitle: 'The Magical Adventure',
      bookCoverPrompt: 'A colorful cartoon illustration of a young wizard',
      bookBackCoverPrompt: 'The back of the magical castle with stars',
      synopses: 'A young wizard discovers their magical powers',
      chapters: [
        {
          chapterNumber: 1,
          chapterTitle: 'The Discovery',
          chapterSynopses: 'A child finds a magical wand in the attic',
          chapterPhotoPrompt: 'A cartoon illustration of a child in an attic',
        },
      ],
    };

    // Basic structure validation
    expect(validOutline.bookTitle).toBeDefined();
    expect(validOutline.chapters).toBeDefined();
    expect(Array.isArray(validOutline.chapters)).toBe(true);
    expect(validOutline.chapters[0].chapterNumber).toBe(1);
    expect(typeof validOutline.chapters[0].chapterTitle).toBe('string');
    expect(validOutline.chapters[0].chapterTitle.length).toBeGreaterThan(0);
  });

  const schemasRoot = join(process.cwd(), 'src', 'prompts', 'schemas');

  const expectCharacterEnumsToMatch = (schema: any, checkTraits = true, allowNullableEnums = false) => {
    const characterProps = schema?.properties?.characters?.items?.properties;
    expect(characterProps).toBeDefined();
    const normalizedTypeEnum = allowNullableEnums
      ? characterProps.type.enum.filter((value: unknown) => value !== null)
      : characterProps.type.enum;
    const normalizedRoleEnum = allowNullableEnums
      ? characterProps.role.enum.filter((value: unknown) => value !== null)
      : characterProps.role.enum;
    const normalizedAgeEnum = allowNullableEnums
      ? characterProps.age.enum.filter((value: unknown) => value !== null)
      : characterProps.age.enum;

    expect(normalizedTypeEnum).toEqual([...CHARACTER_TYPES]);
    expect(normalizedRoleEnum).toEqual([...CHARACTER_ROLES]);
    expect(normalizedAgeEnum).toEqual([...CHARACTER_AGES]);
    if (checkTraits) {
      expect(characterProps.traits.items.enum).toEqual([...CHARACTER_TRAITS]);
    }
  };

  test('story-outline schema uses canonical character enums', async () => {
    const schemaPath = join(schemasRoot, 'story-outline.json');
    const schemaContent = await readFile(schemaPath, 'utf-8');
    const schema = JSON.parse(schemaContent);

    expectCharacterEnumsToMatch(schema, true, true);
    expect(schema?.properties?.characters?.items?.additionalProperties).toBe(false);
    expect(schema?.properties?.characters?.items?.required).toEqual([
      'characterId',
      'name',
      'type',
      'age',
      'traits',
      'characteristics',
      'physicalDescription',
      'role',
    ]);
    expect(schema?.properties?.characters?.items?.properties?.characteristics?.type).toEqual([
      'string',
      'null',
    ]);
  });

  test('story-structure schema uses canonical character enums', async () => {
    const schemaPath = join(schemasRoot, 'story-structure.json');
    const schemaContent = await readFile(schemaPath, 'utf-8');
    const schema = JSON.parse(schemaContent);

    expectCharacterEnumsToMatch(schema);
  });
});
