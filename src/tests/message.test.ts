import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('@/config/logger', () => ({
  logger: {
    warn: jest.fn(),
  },
}));

jest.mock('fs', () => ({
  readFileSync: jest.fn(),
}));

jest.mock('@/shared/path-utils', () => ({
  getMessagesPath: jest.fn(() => '/messages'),
}));

import { readFileSync } from 'fs';
import { MessageService } from '../services/message';
import { SUPPORTED_LOCALES } from '@/config/locales.js';
import { logger } from '@/config/logger';

describe('MessageService', () => {
  const sample = {
    Story: {
      credits: 'Credits for {author}',
      tableOfContents: 'TOC',
      storyImaginedBy: 'Imagined by',
      craftedWith: 'Crafted with',
      byAuthor: 'by {author}',
    },
  };

  beforeEach(() => {
    (MessageService as any).messagesCache = new Map();
    (readFileSync as jest.Mock).mockReset();
    jest.clearAllMocks();
  });

  it('loads and caches messages', async () => {
    (readFileSync as jest.Mock).mockReturnValueOnce(JSON.stringify(sample));

    const first = await MessageService.loadMessages('en-US');
    const second = await MessageService.loadMessages('en-US');

    expect(first.Story.tableOfContents).toBe('TOC');
    expect(second.Story.tableOfContents).toBe('TOC');
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it('normalizes locale formats', async () => {
    (readFileSync as jest.Mock).mockReturnValueOnce(JSON.stringify(sample));

    await MessageService.loadMessages('pt');

    expect(readFileSync).toHaveBeenCalledWith('/messages/pt-PT/common.json', 'utf-8');
  });

  it('falls back to en-US when locale missing', async () => {
    (readFileSync as jest.Mock).mockImplementation((path: string) => {
      if (path.includes('pt-PT')) throw new Error('missing');
      return JSON.stringify(sample);
    });

    const messages = await MessageService.loadMessages('pt-PT');
    expect(messages.Story.tableOfContents).toBe('TOC');
    expect(logger.warn).toHaveBeenCalled();
    expect(readFileSync).toHaveBeenCalledWith('/messages/en-US/common.json', 'utf-8');
  });

  it('returns default messages when en-US missing', async () => {
    (readFileSync as jest.Mock).mockImplementation(() => {
      throw new Error('missing');
    });

    const messages = await MessageService.loadMessages('fr');
    expect(messages.Story.tableOfContents).toBe('Table of Contents');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('accessor helpers return formatted strings', async () => {
    (readFileSync as jest.Mock).mockReturnValue(JSON.stringify(sample));

    const credits = await MessageService.getCreditsMessage('en-US', 'Alice');
    expect(credits).toBe('Credits for Alice');

    const toc = await MessageService.getTableOfContentsTitle('en-US');
    expect(toc).toBe('TOC');

    const imagined = await MessageService.getStoryImaginedByMessage('en-US', 'Alice');
    expect(imagined).toBe('Imagined by <i class="mythoria-author-emphasis">Alice</i>.');

    const crafted = await MessageService.getCraftedWithMessage('en-US');
    expect(crafted).toBe('Crafted with');

    const byAuthor = await MessageService.getByAuthorMessage('en-US', 'Alice');
    expect(byAuthor).toBe('by Alice');
  });

  it('lists supported locales', () => {
    expect(MessageService.getSupportedLocales()).toEqual(Array.from(SUPPORTED_LOCALES));
  });
});
