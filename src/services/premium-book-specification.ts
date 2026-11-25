import type { PremiumManifest } from './premium-book-contract.js';
import { premiumSpecification } from './premium-book-opening.js';
import { openingInk } from './premium-opening-design.js';

type Edition = Pick<PremiumManifest, 'opening' | 'openingDesign' | 'specification'>;
type SpecificationAssets = { logoUrl: string; qrUrl: string };

const specificationLabels = {
  'en-US': 'Publication details',
  'pt-PT': 'Ficha técnica',
  'es-ES': 'Ficha técnica',
  'fr-FR': 'Informations de publication',
  'de-DE': 'Impressum',
} satisfies Record<Edition['opening']['locale'], string>;

export function escapePremiumHtml(text: string) {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
}

export const premiumSpecificationStyles = `
  .specification {
    --spec-unit: 1pt;
    display: grid;
    place-items: center;
  }
  .specification-copy {
    width: calc(454 * var(--spec-unit));
    max-height: calc(502 * var(--spec-unit));
    overflow-wrap: anywhere;
  }
  .specification p { margin: 0; }
  .specification .spec-label {
    font-size: calc(11 * var(--spec-unit));
    font-weight: bold;
    line-height: 1.25;
  }
  .specification .spec-title {
    margin: calc(6 * var(--spec-unit)) 0 calc(24 * var(--spec-unit));
    font-size: calc(30 * var(--spec-unit));
    font-weight: normal;
    line-height: 1.12;
  }
  .specification dl {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: calc(15 * var(--spec-unit)) calc(24 * var(--spec-unit));
    margin: 0;
    padding: calc(18 * var(--spec-unit)) 0;
    border-block: calc(.6 * var(--spec-unit)) solid #a19e88;
  }
  .specification dd {
    margin: calc(4 * var(--spec-unit)) 0 0;
    font-size: calc(14 * var(--spec-unit));
    line-height: 1.28;
  }
  .specification .spec-rights {
    margin: calc(18 * var(--spec-unit)) 0 calc(22 * var(--spec-unit));
    font-size: calc(11 * var(--spec-unit));
    line-height: 1.4;
  }
  .specification .spec-rights p + p { margin-top: calc(5 * var(--spec-unit)); }
  .specification .spec-promotion {
    display: grid;
    grid-template-columns: 1fr 1fr;
    align-items: center;
    gap: calc(15 * var(--spec-unit));
    padding: calc(12 * var(--spec-unit)) calc(23 * var(--spec-unit));
    background: #fefbf6;
    text-align: center;
  }
  .specification .spec-brand {
    display: block;
    width: calc(168 * var(--spec-unit));
    height: auto;
    margin: auto;
  }
  .specification .spec-qr {
    display: block;
    width: calc(72 * var(--spec-unit));
    height: auto;
    margin: 0 auto calc(7 * var(--spec-unit));
  }
  .specification .spec-promotion p {
    font-size: calc(11 * var(--spec-unit));
    line-height: 1.24;
  }
`;

export function renderPremiumSpecificationPage(
  { opening, openingDesign, specification }: Edition,
  { logoUrl, qrUrl }: SpecificationAssets,
) {
  const spec = specification ?? premiumSpecification(opening);
  const details = spec.details
    .map(
      ({ label, value }) =>
        `<div><dt class="spec-label">${escapePremiumHtml(label)}</dt><dd>${escapePremiumHtml(value)}</dd></div>`,
    )
    .join('');
  return `<section class="specification" aria-label="${specificationLabels[opening.locale]}" style="background:${openingDesign?.background ?? '#fbf5e6'};color:${openingInk}">
    <div class="specification-copy fit">
      <p class="spec-label">${escapePremiumHtml(spec.title.label)}</p>
      <h1 class="spec-title">${escapePremiumHtml(spec.title.value)}</h1>
      <dl>${details}</dl>
      <div class="spec-rights"><p><strong>${escapePremiumHtml(spec.copyright)}</strong></p><p>${escapePremiumHtml(spec.rights)}</p></div>
      <div class="spec-promotion">
        <img class="spec-brand" src="${escapePremiumHtml(logoUrl)}" alt="Mythoria">
        <div><img class="spec-qr" src="${escapePremiumHtml(qrUrl)}" alt="mythoria.pt"><p>${escapePremiumHtml(spec.promotion)}</p></div>
      </div>
    </div>
  </section>`;
}

export function renderPremiumSpecificationDocument(edition: Edition, assets: SpecificationAssets) {
  return `<!doctype html>
<html lang="${edition.opening.locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapePremiumHtml(edition.opening.title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; display: grid; place-items: center; min-height: 100dvh; font-family: Georgia, 'Liberation Serif', serif; }
    ${premiumSpecificationStyles}
    .specification {
      --spec-unit: calc(min(100vw, 100dvh) / 630);
      width: min(100vw, 100dvh);
      min-height: min(100vw, 100dvh);
      aspect-ratio: 1;
    }
    @media (max-width: 480px) {
      .specification-copy { width: 88%; max-height: none; padding-block: 8px; }
      .specification .spec-label, .specification .spec-rights, .specification .spec-promotion p {
        font-size: max(9px, calc(11 * var(--spec-unit)));
      }
      .specification dd { font-size: max(10px, calc(14 * var(--spec-unit))); }
      .specification .spec-title { font-size: max(18px, calc(30 * var(--spec-unit))); }
      .specification .spec-qr { width: max(48px, calc(72 * var(--spec-unit))); }
    }
  </style>
</head>
<body>${renderPremiumSpecificationPage(edition, assets)}</body>
</html>`;
}
