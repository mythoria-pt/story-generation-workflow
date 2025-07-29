/**
 * Translation utilities for print service
 */

export interface PrintTranslations {
  titleLabel: string;
  authorLabel: string;
  publishDateLabel: string;
  editingCompanyLabel: string;
  websiteLabel: string;
  copyrightLabel: string;
  copyrightText: string;
  promotionText: string;
  synopsisTitle: string;
  tocTitle: string;
  chapterLabel: string;
}

/**
 * Get localized text based on story language
 */
export function getPrintTranslations(storyLanguage: string): PrintTranslations {
  const isPortuguese = storyLanguage === 'pt-PT';
  
  return {
    titleLabel: isPortuguese ? 'Título' : 'Title',
    authorLabel: isPortuguese ? 'Autor' : 'Author',
    publishDateLabel: isPortuguese ? 'Data de Publicação' : 'Publish Date',
    editingCompanyLabel: isPortuguese ? 'Empresa de Edição' : 'Editing Company',
    websiteLabel: isPortuguese ? 'Website' : 'Website',
    copyrightLabel: isPortuguese ? 'Direitos Autorais' : 'Copyright',
    copyrightText: isPortuguese 
      ? 'Todos os direitos reservados. Nenhuma parte desta publicação pode ser reproduzida, distribuída ou transmitida de qualquer forma ou por qualquer meio sem a permissão prévia por escrito do autor.'
      : 'All rights reserved. No part of this publication may be reproduced, distributed, or transmitted in any form or by any means without the prior written permission of the author.',
    promotionText: isPortuguese 
      ? 'Crie a sua própria história no <strong>Mythoria</strong>'
      : 'Create your own story on <strong>Mythoria</strong>',
    synopsisTitle: isPortuguese ? 'Sinopse' : 'Synopsis',
    tocTitle: isPortuguese ? 'Índice' : 'Table of Contents',
    chapterLabel: isPortuguese ? 'Capítulo' : 'Chapter'
  };
}

/**
 * Format creation date to localized MMM YYYY format
 */
export function formatPublishDate(createdAt: string | Date, storyLanguage: string): string {
  const date = new Date(createdAt);
  
  // Check if date is valid
  if (isNaN(date.getTime())) {
    return '';
  }
  
  const isPortuguese = storyLanguage === 'pt-PT';
  
  const months = isPortuguese ? [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
  ] : [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  
  return `${months[date.getMonth()]} ${date.getFullYear()}`;
}
