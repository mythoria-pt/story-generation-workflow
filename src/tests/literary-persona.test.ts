import { LiteraryPersonaService } from '@/services/literary-persona.js';

describe('LiteraryPersonaService', () => {
  it('formats custom writing persona guidance', () => {
    const guidance = LiteraryPersonaService.formatCustomStyleBlock({
      pov: '2nd',
      tone: 4,
      formality: 2,
      rhythm: 5,
      vocabulary: 3,
      fictionality: 4,
      dialogueDensity: 4,
      sensoriality: 5,
      subtextIrony: 2,
      techniques: ['4th-wall-break'],
      specialRequirements: 'Keep it adventurous but gentle.',
    });

    expect(guidance).toContain('Custom writing persona');
    expect(guidance).toContain('Point of view: 2nd');
    expect(guidance).toContain('Tone (1-5): 4');
    expect(guidance).toContain('Techniques: 4th-wall-break');
    expect(guidance).toContain('Author special requirements: Keep it adventurous but gentle.');
  });

  it('prefers custom persona guidance over built-in codenames', async () => {
    const guidance = await LiteraryPersonaService.buildGuidance(
      'classic-novelist',
      {
        pov: 'objective',
        tone: 1,
        formality: 5,
        rhythm: 2,
        vocabulary: 4,
        fictionality: 1,
      },
      'en-US',
    );

    expect(guidance).toContain('Custom writing persona');
    expect(guidance).toContain('Point of view: objective');
    expect(guidance).not.toContain('Classic Novelist');
  });

  it('falls back to the classic novelist when no persona is selected', async () => {
    const guidance = await LiteraryPersonaService.buildGuidance(null, null, 'en-US');

    expect(guidance).toContain('Classic Novelist');
    expect(guidance).toContain('classic-novelist');
  });
});
