import { readFile } from 'fs/promises';
import { posix as pathPosix } from 'path';
import { logger } from '@/config/logger.js';
import { getPromptsPath } from '@/shared/path-utils.js';

export interface LiteraryPersonaDefinition {
  codename: string;
  name: string;
  description: string;
  pov: '1st' | '2nd' | '3rd-limited' | '3rd-omniscient' | 'objective';
  povAlternatives?: Array<'1st' | '2nd' | '3rd-limited' | '3rd-omniscient' | 'objective'>;
  tone: number;
  toneInstruction?: string;
  formality: number;
  formalityInstruction?: string;
  rhythm: number;
  rhythmInstruction?: string;
  vocabulary: number;
  vocabularyInstruction?: string;
  fictionality: number;
  fictionalityInstruction?: string;
  dialogueDensity?: number;
  dialogueDensityInstruction?: string;
  sensoriality?: number;
  sensorialityInstruction?: string;
  subtextIrony?: number;
  subtextIronyInstruction?: string;
  techniques?: string[];
  whenToUse?: string[];
  example?: string;
}

export class LiteraryPersonaService {
  private static readonly basePath = getPromptsPath();
  private static cache: Record<string, LiteraryPersonaDefinition[]> = {};

  static async loadPersonas(locale = 'en-US'): Promise<LiteraryPersonaDefinition[]> {
    if (this.cache[locale]) {
      return this.cache[locale];
    }

    const personaPath = pathPosix.join(this.basePath, locale, 'literary-personas.json');

    try {
      const content = await readFile(personaPath, 'utf-8');
      const parsed = JSON.parse(content) as LiteraryPersonaDefinition[];
      this.cache[locale] = parsed;
      return parsed;
    } catch (error) {
      logger.warn('Failed to load literary personas, attempting en-US fallback', {
        locale,
        personaPath,
        error: error instanceof Error ? error.message : String(error),
      });

      if (locale !== 'en-US') {
        return this.loadPersonas('en-US');
      }

      throw new Error('Unable to load literary personas');
    }
  }

  static async getPersona(
    codename?: string | null,
    locale = 'en-US',
  ): Promise<LiteraryPersonaDefinition | null> {
    if (!codename) return null;
    const normalized = codename.trim().toLowerCase();
    const personas = await this.loadPersonas(locale);
    const match = personas.find((p) => p.codename.toLowerCase() === normalized);
    if (match) {
      return match;
    }

    if (locale !== 'en-US') {
      return this.getPersona(codename, 'en-US');
    }

    return null;
  }

  static buildOptionsSummary(personas: LiteraryPersonaDefinition[]): string {
    return personas
      .map((persona) => `- ${persona.codename}: ${persona.name} - ${persona.description}`)
      .join('\n');
  }

  static formatStyleBlock(persona: LiteraryPersonaDefinition): string {
    const optional = (label: string, value?: string | number) =>
      value !== undefined && value !== null && value !== '' ? `${label}: ${value}` : null;

    const lines = [
      `Literary persona: ${persona.name} (${persona.codename})`,
      `Summary: ${persona.description}`,
      `Point of view: ${persona.pov}${
        persona.povAlternatives && persona.povAlternatives.length
          ? ` (alternatives: ${persona.povAlternatives.join(', ')})`
          : ''
      }`,
      optional('Tone (1-5)', persona.tone),
      persona.toneInstruction,
      optional('Formality (1-5)', persona.formality),
      persona.formalityInstruction,
      optional('Rhythm (1-5)', persona.rhythm),
      persona.rhythmInstruction,
      optional('Vocabulary (1-5)', persona.vocabulary),
      persona.vocabularyInstruction,
      optional('Fictionality (1-5)', persona.fictionality),
      persona.fictionalityInstruction,
      optional('Dialogue density (1-5)', persona.dialogueDensity),
      persona.dialogueDensityInstruction,
      optional('Sensoriality (1-5)', persona.sensoriality),
      persona.sensorialityInstruction,
      optional('Subtext/Irony (1-5)', persona.subtextIrony),
      persona.subtextIronyInstruction,
      persona.techniques && persona.techniques.length
        ? `Techniques: ${persona.techniques.join(', ')}`
        : null,
      persona.whenToUse && persona.whenToUse.length
        ? `Best for: ${persona.whenToUse.join('; ')}`
        : null,
      persona.example ? `Style example: ${persona.example}` : null,
    ].filter(Boolean) as string[];

    return lines.join('\n');
  }
}
