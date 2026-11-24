import type { SupportedLocale } from '@/config/locales.js';
import type { PremiumPage } from './premium-book-contract.js';

export const PREMIUM_INVITATION_PAGE_NUMBER = 33;

const copy: Record<SupportedLocale, { title: string; body: string; label: string }> = {
  'en-US': {
    title: 'Did you enjoy this story?',
    body: 'Now it’s your turn. What will happen in your story?',
    label: 'Write your story on Mythoria',
  },
  'pt-PT': {
    title: 'Gostaste desta história?',
    body: 'Agora é a tua vez. O que vai acontecer na tua história?',
    label: 'Cria a tua história na Mythoria',
  },
  'es-ES': {
    title: '¿Te ha gustado esta historia?',
    body: 'Ahora te toca a ti. ¿Qué pasará en tu historia?',
    label: 'Escribe tu historia en Mythoria',
  },
  'fr-FR': {
    title: 'Cette histoire t’a plu ?',
    body: 'À ton tour. Que va-t-il se passer dans ton histoire ?',
    label: 'Écris ton histoire sur Mythoria',
  },
  'de-DE': {
    title: 'Hat dir diese Geschichte gefallen?',
    body: 'Jetzt bist du dran. Was wird in deiner Geschichte passieren?',
    label: 'Schreib deine Geschichte auf Mythoria',
  },
};

export function premiumInvitationHref(locale: SupportedLocale): string {
  return `https://mythoria.pt/${locale}/tell-your-story`;
}

export function premiumInvitationPage(locale: SupportedLocale): PremiumPage {
  const { title, body, label } = copy[locale];
  return {
    number: PREMIUM_INVITATION_PAGE_NUMBER,
    kind: 'invitation',
    text: `${title}\n\n${body}`,
    link: { label, href: premiumInvitationHref(locale) },
  };
}
