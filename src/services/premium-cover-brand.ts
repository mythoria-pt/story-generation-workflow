import { z } from 'zod';

const styleLogos = {
  anime: 'anime.jpg',
  cartoon: 'cartoon.jpg',
  claymation: 'claymation.jpg',
  colored_pencil: 'colored_pencil.jpg',
  comic_book: 'comic_book.jpg',
  digital_art: 'digital_art.jpg',
  disney_style: 'disney.jpg',
  hand_drawn: 'hand_drawn.jpg',
  minimalist: 'minimalist.jpg',
  oil_painting: 'oil-painting.jpg',
  papercut: 'papercut.jpg',
  pixar_style: 'pixar.jpg',
  realistic: 'realistic.jpg',
  sketch: 'sketch.jpg',
  vintage: 'vintage.jpg',
  watercolor: 'watercolor.jpg',
} as const;

export const premiumCoverFallbackLogo = 'mythoria-logo.png';
export const premiumCoverLogo = z.enum([...Object.values(styleLogos), premiumCoverFallbackLogo]);

export function premiumCoverLogoForStyle(style: string | null | undefined) {
  if (style && Object.hasOwn(styleLogos, style)) {
    return styleLogos[style as keyof typeof styleLogos];
  }
  return premiumCoverFallbackLogo;
}
