import { premiumNarrationPages } from '@/services/premium-audiobook.js';
import type { PremiumManifest } from '@/services/premium-book-contract.js';

it('uses canonical narrative pages in physical order, omitting silent and back matter pages', () => {
  const page = (number: number, kind: PremiumManifest['pages'][number]['kind'], text: string) => ({
    number,
    kind,
    text,
  });
  const opening = page(5, 'opener', 'It was early.\n\nThe sun came up.');
  const right = page(7, 'spread', 'The boat rocked gently.');
  const ending = page(32, 'ending', 'The End.');
  expect(
    premiumNarrationPages({
      pages: [
        page(1, 'title', 'Title'),
        page(2, 'copyright', 'Imprint'),
        page(4, 'synopsis', 'Synopsis'),
        opening,
        page(6, 'spread', ''),
        right,
        ending,
        page(33, 'invitation', 'Start a new book'),
      ],
    }),
  ).toEqual([opening, right, ending]);
});
