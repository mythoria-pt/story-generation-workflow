import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('@/config/logger', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
}));

jest.mock('@/shared/path-utils', () => ({
  getPromptsPath: jest.fn(() => '/prompts'),
}));

import { readFile } from 'fs/promises';
import { PromptService } from '../services/prompt';
import { logger } from '@/config/logger';

describe('PromptService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads prompt template', async () => {
    (readFile as jest.Mock).mockResolvedValue('{"userPrompt":"Hi"}');

    const result = await PromptService.loadPrompt('en-US', 'greet');

    expect(result.userPrompt).toBe('Hi');
    expect(readFile).toHaveBeenCalledWith('/prompts/en-US/greet.json', 'utf-8');
    expect(logger.debug).toHaveBeenCalled();
  });

  it('throws when prompt template missing', async () => {
    (readFile as jest.Mock).mockRejectedValue(new Error('missing'));

    await expect(PromptService.loadPrompt('en-US', 'miss')).rejects.toThrow(
      'Failed to load prompt template: en-US/miss',
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it('processes variables and conditionals', () => {
    const template = 'Hello {{name}} {{#extra}}Extra: {{extra}}{{/extra}}';
    const result = PromptService.processPrompt(template, { name: 'World', extra: '!' });
    expect(result).toBe('Hello World Extra: !');

    const noExtra = PromptService.processPrompt(template, { name: 'World', extra: '' });
    expect(noExtra).toBe('Hello World ');
  });

  it('builds combined prompts', () => {
    const tmpl = { systemPrompt: 'sys {{v}}', userPrompt: 'user {{v}}' };
    const built = PromptService.buildPrompt(tmpl, { v: 'x' });
    expect(built).toBe('sys x\n\nuser x');

    const builtNoSys = PromptService.buildPrompt({ userPrompt: 'only' }, {});
    expect(builtNoSys).toBe('only');
  });

  it('loads image prompt template', async () => {
    (readFile as jest.Mock).mockResolvedValue('{"userPrompt":"Img"}');

    const result = await PromptService.loadImagePrompt('cover');

    expect(result.userPrompt).toBe('Img');
    expect(readFile).toHaveBeenCalledWith('/prompts/images/cover.json', 'utf-8');
  });

  it('throws when image prompt missing', async () => {
    (readFile as jest.Mock).mockRejectedValue(new Error('missing'));

    await expect(PromptService.loadImagePrompt('cover')).rejects.toThrow(
      'Failed to load image prompt template: images/cover.json',
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it('loads image styles', async () => {
    (readFile as jest.Mock).mockResolvedValue('{"fantasy":{"systemPrompt":"s","style":"f"}}');

    const styles = await PromptService.loadImageStyles();

    expect(styles.fantasy.style).toBe('f');
    expect(readFile).toHaveBeenCalledWith('/prompts/imageStyles.json', 'utf-8');
  });

  it('throws when image styles missing', async () => {
    (readFile as jest.Mock).mockRejectedValue(new Error('missing'));

    await expect(PromptService.loadImageStyles()).rejects.toThrow(
      'Failed to load image styles configuration',
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it('gets existing image style', async () => {
    const styles = { fantasy: { systemPrompt: 's', style: 'f' } };
    jest.spyOn(PromptService, 'loadImageStyles').mockResolvedValue(styles);

    const style = await PromptService.getImageStylePrompt('fantasy');
    expect(style.style).toBe('f');
  });

  it('returns default style when missing', async () => {
    jest.spyOn(PromptService, 'loadImageStyles').mockResolvedValue({});

    const style = await PromptService.getImageStylePrompt('unknown');
    expect(style.style).toContain('high quality');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('lists available image styles', async () => {
    jest
      .spyOn(PromptService, 'loadImageStyles')
      .mockResolvedValue({ fantasy: {}, noir: {} } as any);

    const styles = await PromptService.getAvailableImageStyles();
    expect(styles).toEqual(['fantasy', 'noir']);
  });

  it('builds a provider-neutral image prompt with the selected style', async () => {
    jest.spyOn(PromptService, 'loadImagePrompt').mockResolvedValue({
      systemPrompt:
        'Cover for {{bookTitle}}. Scene: {{promptText}}. {{#customInstructions}}Notes: {{customInstructions}}{{/customInstructions}}',
      userPrompt: 'Generate the illustration.',
    });
    jest.spyOn(PromptService, 'getImageStylePrompt').mockResolvedValue({
      systemPrompt: '<art_style>handcrafted clay stop-motion illustration</art_style>',
      style: 'handcrafted clay stop-motion illustration',
    });

    const result = await PromptService.buildImageGenerationPrompt(
      'front_cover',
      {
        bookTitle: 'The Lantern Path',
        promptText: 'A traveller entering a moonlit forest',
        customInstructions: '  Use warm amber highlights.  ',
      },
      'claymation',
    );

    expect(result.systemPrompt).toContain('Cover for The Lantern Path');
    expect(result.systemPrompt).toContain('A traveller entering a moonlit forest');
    expect(result.systemPrompt).toContain('Notes: Use warm amber highlights.');
    expect(result.systemPrompt).toContain(
      '<art_style>handcrafted clay stop-motion illustration</art_style>',
    );
    expect(result.userPrompt).toBe('Generate the illustration.');
    expect(PromptService.getImageStylePrompt).toHaveBeenCalledWith('claymation');
  });

  it('builds an image prompt without style guidance when no style is selected', async () => {
    jest.spyOn(PromptService, 'loadImagePrompt').mockResolvedValue({
      systemPrompt: 'Scene: {{promptText}}',
      userPrompt: 'Generate it.',
    });
    const styleSpy = jest.spyOn(PromptService, 'getImageStylePrompt');

    const result = await PromptService.buildImageGenerationPrompt(
      'chapter',
      { bookTitle: 'Untitled', promptText: 'A quiet library' },
      null,
    );

    expect(result).toEqual({
      systemPrompt: 'Scene: A quiet library',
      userPrompt: 'Generate it.',
    });
    expect(styleSpy).not.toHaveBeenCalled();
  });
});
