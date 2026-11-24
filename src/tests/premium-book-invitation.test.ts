import { describe, expect, it } from '@jest/globals';
import { applyPremiumSpreadText, premiumManifest } from '@/services/premium-book-contract.js';
import { premiumInvitationPage } from '@/services/premium-book-invitation.js';
import { buildPremiumStoryboardPrompt } from '@/services/premium-book-storyboard.js';
import {
  premiumInvitationManifestFixture,
  premiumManifestFixture,
} from './fixtures/premium-book.js';

describe('premium book closing invitation', () => {
  it.each([
    ['en-US', 'Did you enjoy this story?', 'Now it’s your turn.', 'Write your story on Mythoria'],
    ['pt-PT', 'Gostaste desta história?', 'Agora é a tua vez.', 'Cria a tua história na Mythoria'],
    [
      'es-ES',
      '¿Te ha gustado esta historia?',
      'Ahora te toca a ti.',
      'Escribe tu historia en Mythoria',
    ],
    ['fr-FR', 'Cette histoire t’a plu ?', 'À ton tour.', 'Écris ton histoire sur Mythoria'],
    [
      'de-DE',
      'Hat dir diese Geschichte gefallen?',
      'Jetzt bist du dran.',
      'Schreib deine Geschichte auf Mythoria',
    ],
  ] as const)(
    'uses the trusted localized text and creation link for %s',
    (locale, heading, paragraph, label) => {
      const page = premiumInvitationPage(locale);
      expect(page).toMatchObject({ number: 33, kind: 'invitation' });
      const [title, body] = page.text.split('\n\n');
      expect(title).toBe(heading);
      expect(body?.startsWith(paragraph)).toBe(true);
      expect(page.link).toEqual({ label, href: `https://mythoria.pt/${locale}/tell-your-story` });
      expect(page.artwork).toBeUndefined();
      expect(page.reading).toBeUndefined();
      expect(page.spreadId).toBeUndefined();
    },
  );

  it('puts exactly one invitation after the complete narrative and accepts prior 32-page plans', () => {
    const edition = premiumInvitationManifestFixture();
    const prior = premiumManifestFixture();
    expect(edition.format.pageCount).toBe(33);
    expect(edition.pages).toHaveLength(33);
    expect(edition.pages[31]).toMatchObject({
      number: 32,
      kind: 'ending',
      artwork: expect.any(Object),
    });
    expect(edition.pages[32]).toEqual(premiumInvitationPage(edition.opening.locale));
    expect(edition.pages.slice(0, 32)).toEqual(prior.pages);
    expect(edition.spreads).toEqual(prior.spreads);
    expect(premiumManifest.parse(prior).format.pageCount).toBe(32);
  });

  it('rejects count mismatches, displaced invitations, narrative links and image assets on page 33', () => {
    const edition = premiumInvitationManifestFixture();
    const lastPage = edition.pages[32];
    if (!lastPage) throw new Error('Missing invitation fixture');
    const preface = edition.pages.slice(0, 32);
    const valid = { ...edition, pages: [...preface, lastPage] };
    const invalid = [
      { ...edition, format: { ...edition.format, pageCount: 32 } },
      { ...edition, pages: preface },
      { ...edition, pages: [...preface.slice(0, 31), lastPage, preface[31]] },
      {
        ...edition,
        pages: [{ ...preface[0], link: lastPage.link }, ...preface.slice(1), lastPage],
      },
      { ...edition, pages: [...preface, { ...lastPage, reading: edition.covers.front }] },
      { ...edition, pages: [...preface, { ...lastPage, link: undefined }] },
      { ...edition, pages: [...preface, { ...lastPage, text: 'One title only' }] },
    ];
    expect(premiumManifest.safeParse(valid).success).toBe(true);
    for (const value of invalid) expect(premiumManifest.safeParse(value).success).toBe(false);
  });

  it.each([
    'https://example.com/pt-PT/tell-your-story',
    'https://mythoria.pt/en-US/tell-your-story',
    'https://mythoria.pt/pt-PT/tell-your-story?author=123',
    'https://mythoria.pt/pt-PT/tell-your-story#story',
    'https://mythoria.pt/pt-PT/s/fixture',
  ])('rejects a noncanonical destination %s', (href) => {
    const edition = premiumInvitationManifestFixture();
    const lastPage = edition.pages[32];
    expect(
      premiumManifest.safeParse({
        ...edition,
        pages: [...edition.pages.slice(0, 32), { ...lastPage, link: { label: 'Mythoria', href } }],
      }).success,
    ).toBe(false);
  });

  it.each([32, 33])(
    'retains the edition’s exact ending and invitation after a spread correction to %i pages',
    (count) => {
      const current = count === 32 ? premiumManifestFixture() : premiumInvitationManifestFixture();
      const originalEnding = current.pages.slice(31);
      const [spread] = current.spreads;
      const left = current.pages[5];
      const right = current.pages[6];
      if (!spread || !left || !right) throw new Error('Missing spread fixture');
      applyPremiumSpreadText(spread, left, right, { leftText: 'A Inês viu a água.' });
      const revised = premiumManifest.parse({ ...current, previousRevision: current.revision });
      expect(revised.format.pageCount).toBe(count);
      expect(revised.pages.slice(31)).toEqual(originalEnding);
    },
  );

  it('reserves page 33 for the publisher without adding its localized material to the model prompt', () => {
    const book = {
      audience: 'children_3-6' as const,
      opening: { title: 'Inês e o Barquinho', locale: 'pt-PT' },
      direction: 'Um barco de papel.',
      characters: 'Inês',
    };
    const prompt = buildPremiumStoryboardPrompt(book);
    expect(prompt).toContain('33-page book');
    expect(prompt).toContain('Page 33 is reserved for the publisher’s closing invitation');
    expect(prompt).toContain('End the narrative on page 32');
    expect(prompt).not.toContain(premiumInvitationPage('pt-PT').link?.href);
    expect(prompt).not.toContain('Gostaste desta história?');
    const previous = buildPremiumStoryboardPrompt({ ...book, pageCount: 32 });
    expect(previous).toContain('32-page book');
    expect(previous).not.toContain('Page 33');
  });
});
