import type { z } from 'zod';
import type { openingPlan, PremiumPage } from './premium-book-contract.js';
import { getPrintTranslations } from '@/utils/print-translations.js';

type Opening = z.infer<typeof openingPlan>;
const translations = {
  'es-ES': {
    titleLabel: 'Título',
    authorLabel: 'Autor',
    publishDateLabel: 'Fecha de publicación',
    editingCompanyLabel: 'Editorial',
    websiteLabel: 'Sitio web',
    copyrightLabel: 'Derechos de autor',
    copyrightText:
      'Todos los derechos reservados. Ninguna parte de esta publicación puede reproducirse, distribuirse ni transmitirse de ninguna forma ni por ningún medio sin el permiso previo por escrito del autor.',
    promotionText: 'Crea tu propia historia en Mythoria',
    synopsisTitle: 'Sinopsis',
  },
  'fr-FR': {
    titleLabel: 'Titre',
    authorLabel: 'Auteur',
    publishDateLabel: 'Date de publication',
    editingCompanyLabel: 'Maison d’édition',
    websiteLabel: 'Site web',
    copyrightLabel: 'Droits d’auteur',
    copyrightText:
      'Tous droits réservés. Aucune partie de cette publication ne peut être reproduite, distribuée ou transmise sous quelque forme ou par quelque moyen que ce soit sans l’autorisation écrite préalable de l’auteur.',
    promotionText: 'Créez votre propre histoire sur Mythoria',
    synopsisTitle: 'Résumé',
  },
  'de-DE': {
    titleLabel: 'Titel',
    authorLabel: 'Autor',
    publishDateLabel: 'Erscheinungsdatum',
    editingCompanyLabel: 'Verlag',
    websiteLabel: 'Website',
    copyrightLabel: 'Urheberrecht',
    copyrightText:
      'Alle Rechte vorbehalten. Kein Teil dieser Veröffentlichung darf ohne vorherige schriftliche Zustimmung des Autors in irgendeiner Form oder auf irgendeine Weise vervielfältigt, verbreitet oder übertragen werden.',
    promotionText: 'Erstelle deine eigene Geschichte auf Mythoria',
    synopsisTitle: 'Kurzbeschreibung',
  },
};

export function premiumOpeningPages(opening: Opening): PremiumPage[] {
  const t =
    opening.locale === 'en-US' || opening.locale === 'pt-PT'
      ? getPrintTranslations(opening.locale)
      : translations[opening.locale];
  const date = new Intl.DateTimeFormat(opening.locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(opening.createdAt));
  return [
    { number: 1, kind: 'title', text: opening.title },
    {
      number: 2,
      kind: 'copyright',
      text: [
        `${t.titleLabel}: ${opening.title}`,
        `${t.authorLabel}: ${opening.author}`,
        `${t.publishDateLabel}: ${date}`,
        `${t.editingCompanyLabel}: Mythoria`,
        `${t.websiteLabel}: mythoria.pt`,
        `${t.copyrightLabel} © ${opening.createdAt.slice(0, 4)} ${opening.author}`,
        t.copyrightText,
        t.promotionText.replace(/<\/?strong>/g, ''),
      ].join('\n'),
    },
    {
      number: 3,
      kind: 'dedication',
      text: [opening.title, opening.dedication, `– ${opening.author}`].filter(Boolean).join('\n\n'),
    },
    { number: 4, kind: 'synopsis', text: `${t.synopsisTitle}\n\n${opening.synopsis}` },
  ];
}
