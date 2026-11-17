import { projectContext, historyTurn } from './contract.js';
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
