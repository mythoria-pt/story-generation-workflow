import { isStoryCreatedEligible } from '../services/story-created-eligibility';

describe('story-created eligibility', () => {
  const outline = [{ stepName: 'generate_outline', status: 'completed' }];
  it('accepts explicit story generations and evidenced legacy generations', () => {
    expect(isStoryCreatedEligible({ serviceCode: 'storyGeneration' }, [])).toBe(true);
    expect(isStoryCreatedEligible(null, outline)).toBe(true);
    expect(
      isStoryCreatedEligible(null, [{ stepName: 'write_chapter_2', status: 'completed' }]),
    ).toBe(true);
  });
  it('fails closed for unrelated, unknown, or unevidenced runs', () => {
    for (const code of ['audioGeneration', 'printGeneration', 'selfPrinting', 'unknown']) {
      expect(isStoryCreatedEligible({ serviceCode: code }, outline)).toBe(false);
    }
    expect(isStoryCreatedEligible({}, outline)).toBe(false);
    expect(isStoryCreatedEligible(null, [{ stepName: 'generate_outline', status: 'failed' }])).toBe(
      false,
    );
    expect(isStoryCreatedEligible(null, [])).toBe(false);
  });
});
