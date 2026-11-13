import {
  selectStoryTextMode,
  narrativeLengthGuidance,
  validateWholeStory,
  validateChapterHtml,
  type StoryTextPolicy,
} from '../services/story-text-policy.js';
import { encryptCheckpoint, decryptCheckpoint } from '../services/story-text-checkpoint.js';
const policy: StoryTextPolicy = {
  mode: 'hybrid',
  audiences: ['young_adult_15-17', 'adult_18+'],
  threshold: 8,
  wholeBudget: 262144,
  chapterBudget: 131072,
};
describe('hybrid story policy', () => {
  it.each([
    ['adult_18+', 7, 'whole_story'],
    ['adult_18+', 8, 'chapter_by_chapter'],
    ['young_adult_15-17', 8, 'chapter_by_chapter'],
    ['children_11-14', 10, 'whole_story'],
    ['children_3-6', 10, 'whole_story'],
    ['all_ages', 10, 'whole_story'],
  ])('routes %s/%s to %s', (audience, count, mode) =>
    expect(selectStoryTextMode(String(audience), Number(count), policy)).toBe(mode),
  );
  it('guides older prose depth while retaining author and genre precedence', () => {
    expect(narrativeLengthGuidance('adult_18+')).toContain('1,500-2,000');
    expect(narrativeLengthGuidance('young_adult_15-17')).toContain('take precedence');
    expect(narrativeLengthGuidance('children_3-6')).not.toContain('1,500');
  });

  it('honors threshold/audience overrides and the rollback switch', () => {
    expect(
      selectStoryTextMode('all_ages', 4, { ...policy, audiences: ['all_ages'], threshold: 4 }),
    ).toBe('chapter_by_chapter');
    expect(selectStoryTextMode('children_0-2', 1, { ...policy, mode: 'chapter_by_chapter' })).toBe(
      'chapter_by_chapter',
    );
  });
  it('rejects missing, duplicate, unordered, empty and unsafe chapters', () => {
    const chapter = { chapterNumber: 1, htmlContent: '<p>Opening.</p>' };
    expect(validateWholeStory(JSON.stringify({ chapters: [chapter] }), 1, 'adult_18+')).toEqual([
      chapter,
    ]);
    for (const chapters of [
      [],
      [chapter, chapter],
      [{ ...chapter, chapterNumber: 2 }],
      [{ ...chapter, htmlContent: '<script>bad</script>' }],
      [{ ...chapter, htmlContent: '<p onclick="bad()">Text</p>' }],
      [{ ...chapter, htmlContent: '<p> </p>' }],
    ])
      expect(() => validateWholeStory(JSON.stringify({ chapters }), 1, 'adult_18+')).toThrow();
  });
  it('retains audience paragraph limits', () => {
    expect(() => validateChapterHtml('<p>One</p>'.repeat(3), 'children_0-2')).toThrow(
      'paragraph limit',
    );
    expect(() => validateChapterHtml('<p>One</p>'.repeat(5), 'children_3-6')).toThrow(
      'paragraph limit',
    );
  });
  it('encrypts sensitive checkpoints and authenticates the run and contents', () => {
    const artifact = encryptCheckpoint(
      { token: 'secret-token', manuscript: 'Private text' },
      'run-1',
    );
    expect(artifact.toString()).not.toContain('Private text');
    expect(decryptCheckpoint(artifact, 'run-1')).toEqual({
      token: 'secret-token',
      manuscript: 'Private text',
    });
    expect(() => decryptCheckpoint(artifact, 'run-2')).toThrow();
    artifact[30] = artifact[30]! ^ 1;
    expect(() => decryptCheckpoint(artifact, 'run-1')).toThrow();
  });
});
