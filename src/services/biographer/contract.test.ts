import {
  historyTurn,
  projectContext,
  whispererCondenseRequest,
  whispererRequest,
} from './contract.js';
describe('collaborative interview context', () => {
  it('preserves selected recollection attribution without a raw interview channel', () => {
    const memory = {
      sourceId: '123e4567-e89b-42d3-a456-426614174000',
      contributorName: 'Carla',
      text: 'Andrea blamed the signs.',
    };
    expect(
      projectContext.parse({ sharedMemories: [memory], relationship: 'Sister' }).sharedMemories,
    ).toEqual([memory]);
    expect(
      historyTurn.parse({
        role: 'user',
        text: 'I recall it differently.',
        contributorName: 'Andrea',
      }).contributorName,
    ).toBe('Andrea');
  });
  it('bounds shared evidence and follow-up instructions', () => {
    expect(projectContext.safeParse({ followUps: Array(6).fill('Ask about school') }).success).toBe(
      false,
    );
    expect(
      projectContext.safeParse({
        sharedMemories: [{ sourceId: 'invalid', contributorName: 'Carla', text: 'Memory' }],
      }).success,
    ).toBe(false);
  });
});

describe('Story Whisperer text and live continuity contract', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const base = { authorId: id, projectId: id, locale: 'pt-PT' };

  it('preserves the same intent and displayed opening in text and voice', () => {
    const context = {
      primaryIntent: 'romance',
      opening: {
        question: 'Que momento da vossa história queres guardar?',
        choices: ['Como nos conhecemos'],
      },
    };
    expect(projectContext.parse(context)).toEqual(context);
    expect(
      whispererRequest.parse({ ...base, turns: [], photos: [], requestQuestion: true, context })
        .context,
    ).toEqual(context);
  });

  it('bounds the combined length of answer and question seed entries', () => {
    const entries = ['x'.repeat(19999), { question: 'A?', text: 'x'.repeat(40000) }];
    expect(whispererCondenseRequest.safeParse({ ...base, entries, maxLength: 1000 }).success).toBe(
      false,
    );
  });
});
