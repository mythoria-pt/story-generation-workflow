import { describe, expect, it, jest } from '@jest/globals';
import { premiumOpeningPages, premiumSpecification } from '@/services/premium-book-opening.js';
import { renderPremiumSpecificationDocument } from '@/services/premium-book-specification.js';
import { renderSquarePdf } from '@/services/premium-order-proof.js';
import { premiumSpecificationText } from '@/services/premium-book-contract.js';
import { PrintService, printQrUrl } from '@/services/print.js';
import {
  premiumInvitationManifestFixture,
  premiumLetteredManifestFixture,
} from './fixtures/premium-book.js';

describe('premium square specification page', () => {
  it.each([
    ['en-US', 'Title', 'Publish Date', 'Copyright'],
    ['pt-PT', 'Título', 'Data de Publicação', 'Direitos de Autor'],
    ['es-ES', 'Título', 'Fecha de publicación', 'Derechos de autor'],
    ['fr-FR', 'Titre', 'Date de publication', 'Droits d’auteur'],
    ['de-DE', 'Titel', 'Erscheinungsdatum', 'Urheberrecht'],
  ] as const)(
    'typesets the localized %s page only when selected',
    async (locale, title, date, copyright) => {
      const book = premiumInvitationManifestFixture();
      book.opening = { ...book.opening, locale, title: 'Bea & her <friends>' };
      book.pages.splice(0, 4, ...premiumOpeningPages(book.opening));
      const lettered = premiumLetteredManifestFixture();
      lettered.opening = book.opening;
      lettered.specification = premiumSpecification(book.opening);
      lettered.pages.splice(0, 4, ...premiumOpeningPages(book.opening));
      const stop = new Error('captured HTML');
      const render = jest.spyOn(PrintService.prototype, 'renderPDF').mockRejectedValue(stop);
      const unavailable = jest.fn(async () => {
        throw new Error('Unexpected image access');
      });

      try {
        await expect(
          renderSquarePdf(book, '', 'interior', unavailable, unavailable),
        ).rejects.toThrow(stop.message);
        await expect(
          renderSquarePdf(lettered, '', 'interior', unavailable, unavailable),
        ).rejects.toThrow(stop.message);

        const [legacy, selected] = render.mock.calls.map(
          ([html]) => html.match(/<section\b[^>]*>[\s\S]*?<\/section>/g) ?? [],
        );
        expect(legacy?.[1]).toContain(`${title}: Bea &amp; her &lt;friends&gt;`);
        expect(legacy?.[1]).toContain(`class="qr" src="${printQrUrl}"`);
        expect(legacy?.[1]).not.toContain('mythoria-logo.png');

        const specification = selected?.[1];
        expect(specification).toContain(`<p class="spec-label">${title}</p>`);
        expect(specification).toContain('Bea &amp; her &lt;friends&gt;');
        expect(specification).toContain(`<dt class="spec-label">${date}</dt>`);
        expect(specification).toContain(`${copyright} © ${book.opening.createdAt.slice(0, 4)}`);
        expect(specification).toContain(book.opening.author);
        expect(specification).toContain('mythoria.pt');
        expect(specification).toContain('mythoria-logo.png');
        expect(specification).toContain(`class="spec-qr" src="${printQrUrl}"`);
        const [rights, promotion] = book.pages[1]!.text.split('\n').slice(-2);
        expect(specification).toContain(rights);
        expect(specification).toContain(promotion);
        for (const index of [0, 2, 3, 32]) expect(selected?.[index]).toEqual(legacy?.[index]);

        const document = renderPremiumSpecificationDocument(lettered, {
          logoUrl: 'spec-logo.png',
          qrUrl: 'spec-qr.png',
        });
        expect(document).toContain(`<html lang="${locale}">`);
        const readerMarkup = specification!
          .replace(/https:[^"]+mythoria-logo\.png/, 'spec-logo.png')
          .replace(printQrUrl, 'spec-qr.png');
        expect(document).toContain(readerMarkup);
      } finally {
        render.mockRestore();
      }
    },
  );
  it('prints the published technical wording even if current locale defaults differ', async () => {
    const book = premiumLetteredManifestFixture();
    const specification = { ...book.specification!, rights: 'Frozen publication terms.' };
    book.specification = specification;
    book.pages[1]!.text = premiumSpecificationText(specification);
    const render = jest.spyOn(PrintService.prototype, 'renderPDF').mockRejectedValue('captured');
    const unavailable = jest.fn(async () => {
      throw new Error('Unexpected image access');
    });
    try {
      await expect(renderSquarePdf(book, '', 'interior', unavailable, unavailable)).rejects.toBe(
        'captured',
      );
      expect(render.mock.calls[0]?.[0]).toContain(specification.rights);
      expect(render.mock.calls[0]?.[0]).not.toContain(premiumSpecification(book.opening).rights);
    } finally {
      render.mockRestore();
    }
  });
});
