import {
  approvedOutline,
  chapterEvidence,
  generationSnapshot,
  validateGenerationSnapshot,
} from './snapshot.js';

const id = '11111111-1111-4111-8111-111111111111';
const snapshot = generationSnapshot.parse({
  schemaVersion: 1,
  projectId: id,
  revision: 3,
  persona: 'contextual-storyteller',
  personaVersion: 1,
  effectivePersonaGuidance: 'Minimal fictionality, verified context.',
  title: 'The Map Was Wrong',
  synopsis: 'Our family remembers Andorra.',
  targetWords: 2000,
  omittedSources: [],
  research: [],
  turns: [
    {
      id,
      role: 'user',
      text: 'Mother said the map was wrong, not us. We stayed at the little cafe for hours.',
    },
  ],
  chapters: [
    {
      number: 1,
      title: 'A Different Turning',
      synopsis: 'The remembered ski trip.',
      sourceTurnIds: [id],
    },
  ],
});

describe('approved Biographer generation', () => {
  it('preserves the exact approved title and chapter direction rather than regenerating it', () => {
    const outline = approvedOutline(snapshot);
    expect(outline.bookTitle).toBe(snapshot.title);
    expect(outline.chapters[0]).toMatchObject({
      chapterTitle: 'A Different Turning',
      chapterSynopses: 'The remembered ski trip.',
    });
  });
  it('retains detailed original language and source IDs in chapter evidence', () => {
    const evidence = chapterEvidence(snapshot, 1);
    expect(evidence.turns[0]?.text).toContain('the map was wrong, not us');
    expect(evidence.turns[0]?.id).toBe(id);
    expect(evidence.targetWords).toBe(2000);
  });
  it('retains research in previously approved snapshots', () => {
    const research = [{ url: 'https://example.org/history', title: 'History', text: 'Context' }];
    expect(
      chapterEvidence(validateGenerationSnapshot({ ...snapshot, research }), 1).research,
    ).toEqual(research);
  });
  it('fails closed when an approved source is missing', () => {
    expect(() => chapterEvidence({ ...snapshot, turns: [] }, 1)).toThrow(
      'Approved source turns missing',
    );
  });
  it('refuses unknown chapters', () => {
    expect(() => chapterEvidence(snapshot, 2)).toThrow('Chapter missing');
  });
});

describe('proposal source coverage', () => {
  const omittedId = '22222222-2222-4222-8222-222222222222';
  it('accepts an explained omitted short response for creator review', () => {
    const value = {
      ...snapshot,
      turns: [...snapshot.turns, { id: omittedId, role: 'user', text: 'Yes.' }],
      omittedSources: [{ id: omittedId, reason: 'Acknowledgement' }],
    };
    expect(validateGenerationSnapshot(value).omittedSources[0]?.id).toBe(omittedId);
  });
  it('rejects silent omissions, unknown sources and invalid chapter lengths', () => {
    expect(() =>
      validateGenerationSnapshot({
        ...snapshot,
        turns: [...snapshot.turns, { id: omittedId, role: 'user', text: 'Yes.' }],
      }),
    ).toThrow();
    expect(() =>
      validateGenerationSnapshot({
        ...snapshot,
        omittedSources: [{ id: omittedId, reason: 'Unknown' }],
      }),
    ).toThrow();
    expect(() => validateGenerationSnapshot({ ...snapshot, targetWords: 20000 })).toThrow();
  });
});
