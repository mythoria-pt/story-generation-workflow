import type { z } from 'zod';
import {
  premiumSpecificationText,
  type openingPlan,
  type PremiumPage,
} from './premium-book-contract.js';
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

export const premiumPublicationDomain = 'mythoria.pt';

export function premiumSpecification(opening: Opening, generationDesignVersion?: 1) {
  const t =
    opening.locale === 'en-US' || opening.locale === 'pt-PT'
      ? getPrintTranslations(opening.locale)
      : translations[opening.locale];
  const date = new Intl.DateTimeFormat(opening.locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(opening.createdAt));
  return {
    title: { label: t.titleLabel, value: opening.title },
    details: [
      { label: t.authorLabel, value: opening.author },
      { label: t.publishDateLabel, value: date },
      { label: t.editingCompanyLabel, value: 'Mythoria' },
      { label: t.websiteLabel, value: premiumPublicationDomain },
    ],
    copyright: `${t.copyrightLabel} © ${opening.createdAt.slice(0, 4)} ${opening.author}`,
    rights: t.copyrightText,
    promotion:
      generationDesignVersion === 1
        ? premiumPublicationDomain
        : t.promotionText.replace(/<\/?strong>/g, ''),
    synopsisLabel: t.synopsisTitle,
  };
}

export function premiumOpeningPages(
  opening: Opening,
  generationDesignVersion?: 1,
): [title: PremiumPage, publication: PremiumPage, dedication: PremiumPage, synopsis: PremiumPage] {
  const specification = premiumSpecification(opening, generationDesignVersion);
  return [
    { number: 1, kind: 'title', text: opening.title },
    {
      number: 2,
      kind: 'copyright',
      text: premiumSpecificationText(specification),
    },
    {
      number: 3,
      kind: 'dedication',
      text: [opening.title, opening.dedication, `– ${opening.author}`].filter(Boolean).join('\n\n'),
    },
    { number: 4, kind: 'synopsis', text: `${specification.synopsisLabel}\n\n${opening.synopsis}` },
  ];
}
