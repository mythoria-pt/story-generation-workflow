import { createHash } from 'node:crypto';
import {
  premiumGeometry,
  PREMIUM_PRINT_PPI,
  PREMIUM_READING_PPI,
} from '@/services/premium-book-artwork.js';
import {
  PREMIUM_BOOK_TYPE,
  PREMIUM_FORMAT,
  PREMIUM_TEXT_BOX,
  premiumManifest,
  premiumRevisionPrefix,
  type PremiumPage,
} from '@/services/premium-book-contract.js';
import { premiumOpeningPages } from '@/services/premium-book-opening.js';

const storyId = 'e6ef0522-676b-4fa4-92d1-03fd3fc8c917';
const ownerId = 'c9b56b72-df63-4596-8cea-2ebf603642b4';
const revision = '25107e7f-4528-4105-bd25-3b795cc1c6df';

export function premiumManifestFixture(mixed = true, dedication = '') {
  const prefix = premiumRevisionPrefix(storyId, revision);
  const metadata = (name: string, ext: 'jpg' | 'png') => {
    const sha256 = createHash('sha256').update(name).digest('hex');
    return {
      key: `${prefix}/assets/${sha256}.${ext}`,
      generation: '101',
      sha256,
      bytes: name.length,
    };
  };
  const opening = {
    title: 'Inês e o Barquinho',
    author: 'João Freitas',
    locale: 'pt-PT' as const,
    dedication,
    synopsis: 'Inês segue a água até ao mar.',
    createdAt: '2026-11-24T22:00:00.000Z',
  };
  const pages = premiumOpeningPages(opening);
  const art = (
    number: number,
    facing: boolean,
    side = 0,
  ): Pick<PremiumPage, 'artwork' | 'reading' | 'digitalCrop' | 'printCrop'> => ({
    artwork: metadata(`print-${number}`, 'jpg'),
    reading: metadata(`reading-${number}`, 'png'),
    digitalCrop: premiumGeometry(PREMIUM_READING_PPI, facing).reading[side],
    printCrop: premiumGeometry(PREMIUM_PRINT_PPI, facing).print[side],
  });
  pages.push({
    number: 5,
    kind: 'opener',
    text: 'A Inês ouviu a maré.',
    textBox: PREMIUM_TEXT_BOX,
    ...art(5, false),
  });
  const spreads = Array.from({ length: 13 }, (_, index) => {
    const leftPage = 6 + index * 2;
    const rightPage = leftPage + 1;
    const id = `spread-${index + 1}`;
    const silent = mixed && [2, 5, 11].includes(index);
    pages.push(
      {
        number: leftPage,
        kind: 'spread',
        spreadId: id,
        text: silent ? '' : 'Inês caminhou junto à água.',
        ...(!silent && { textBox: PREMIUM_TEXT_BOX }),
        ...art(leftPage, true),
      },
      {
        number: rightPage,
        kind: 'spread',
        spreadId: id,
        text: 'O barquinho ia à frente, feliz.',
        textBox: PREMIUM_TEXT_BOX,
        ...art(rightPage, true, 1),
      },
    );
    return {
      id,
      leftPage,
      rightPage,
      ...(mixed && { textLayout: silent ? 'right_only' : 'both_pages' }),
      ...(silent && { leftDescription: 'À esquerda, a Inês espreita a água junto à margem.' }),
      master: metadata(id, 'png'),
      source: metadata(`${id}-source`, 'png'),
      action: 'Inês follows the little boat.',
      nativeWidth: 3840,
      nativeHeight: 1952,
      effectivePpi: 222.6,
    };
  });
  pages.push({
    number: 32,
    kind: 'ending',
    text: 'Até amanhã, barquinho!',
    textBox: PREMIUM_TEXT_BOX,
    ...art(32, false),
  });
  return premiumManifest.parse({
    version: 1,
    type: PREMIUM_BOOK_TYPE,
    storyId,
    ownerId,
    revision,
    format: PREMIUM_FORMAT,
    opening,
    pages,
    spreads,
    reference: metadata('reference', 'jpg'),
    covers: { front: metadata('front', 'jpg'), back: metadata('back', 'jpg') },
    config: {
      provider: 'openai',
      model: 'gpt-image-2.6-sunburst',
      quality: 'high',
      spreadSize: '3840x1952',
      squareSize: '1536x1536',
    },
    textConfig: { provider: 'google-genai', model: 'gemini-4-hydrogen' },
    inputHash: metadata('input', 'jpg').sha256,
    visualGuide: 'Watercolor kingfisher blue.',
    natives: {},
  });
}
