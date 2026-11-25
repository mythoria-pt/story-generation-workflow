import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PREMIUM_FORMAT, type PremiumManifest } from './premium-book-contract.js';
import { escapePremiumHtml } from './premium-book-specification.js';
import { openingInk } from './premium-opening-design.js';

export type PremiumTypesetPage = { number: number; text: string };

const { bleedPoints } = PREMIUM_FORMAT;
const typesetFont = 'Literata';

export async function premiumTypesetStyles() {
  const font = await readFile(
    join('print-assets', 'premium-typeset', 'premium-literata-regular.woff2'),
  );
  return `
    @font-face {
      font-family: ${typesetFont};
      src: url(data:font/woff2;base64,${font.toString('base64')}) format('woff2');
      font-weight: 400;
      font-style: normal;
    }
    .typeset-area {
      position: absolute;
      top: ${bleedPoints + 66}pt;
      left: ${bleedPoints + 60}pt;
      width: 474pt;
      height: 480pt;
      display: grid;
      align-items: center;
    }
    .typeset-recto .typeset-area { left: ${bleedPoints + 78}pt; }
    .typeset-copy {
      width: 100%;
      max-height: 480pt;
      font-family: ${typesetFont}, serif;
      font-size: 29pt;
      font-weight: 400;
      line-height: 1.4;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .typeset-younger .typeset-copy { font-size: 32pt; }
  `;
}

export function renderPremiumTypesetPage(
  page: PremiumTypesetPage,
  audience: NonNullable<PremiumManifest['audience']>,
  background = '#fbf5e6',
) {
  const side = page.number % 2 === 0 ? 'verso' : 'recto';
  const size = audience === 'children_0-2' ? ' typeset-younger' : '';
  return `<section class="typeset typeset-${side}${size}" style="background:${background};color:${openingInk}">
    <div class="typeset-area"><div class="typeset-copy fit" data-fit-id="${page.number}" data-fit-font="${typesetFont}">${escapePremiumHtml(page.text)}</div></div>
  </section>`;
}
