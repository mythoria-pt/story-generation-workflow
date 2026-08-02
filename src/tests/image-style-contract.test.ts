import { readFile } from 'fs/promises';
import { posix as pathPosix } from 'path';
import { graphicalStyleEnum } from '@/db/schema/enums.js';
import type { ImageStylesCollection } from '@/services/prompt.js';
import { getPromptsPath } from '@/shared/path-utils.js';

interface StoryStructureSchema {
  properties: {
    story: {
      properties: {
        graphicalStyle: {
          enum: string[];
        };
      };
    };
  };
}

describe('graphical style contract', () => {
  it('keeps prompt styles, story structure, and the shared database mirror in parity', async () => {
    const promptsPath = getPromptsPath();
    const [stylesJson, schemaJson] = await Promise.all([
      readFile(pathPosix.join(promptsPath, 'imageStyles.json'), 'utf-8'),
      readFile(pathPosix.join(promptsPath, 'schemas', 'story-structure.json'), 'utf-8'),
    ]);
    const styles = JSON.parse(stylesJson) as ImageStylesCollection;
    const schema = JSON.parse(schemaJson) as StoryStructureSchema;
    const schemaValues = schema.properties.story.properties.graphicalStyle.enum;

    expect(Object.keys(styles)).toEqual(schemaValues);
    expect(graphicalStyleEnum.enumValues).toEqual(schemaValues);
  });

  it.each(['claymation', 'papercut'])(
    '%s has complete material and print guidance',
    async (style) => {
      const stylesJson = await readFile(
        pathPosix.join(getPromptsPath(), 'imageStyles.json'),
        'utf-8',
      );
      const styles = JSON.parse(stylesJson) as ImageStylesCollection;
      const config = styles[style];

      expect(config).toBeDefined();
      expect(config.systemPrompt.length).toBeGreaterThan(500);
      expect(config.style.length).toBeGreaterThan(100);
      expect(config.systemPrompt).toMatch(/handcrafted|hand-cut/i);
      expect(config.systemPrompt).toMatch(/print/i);
      expect(config.systemPrompt).toMatch(/avoid/i);
    },
  );
});
