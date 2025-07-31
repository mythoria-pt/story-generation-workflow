/**
 * Page estimation utility for calculating chapter content pages based on target audience
 */

interface PageCapacity {
  firstPage: number;  // Characters that fit on first page (excluding title)
  fullPage: number;   // Characters that fit on subsequent full pages
}

/**
 * Character capacity for each target audience
 * Based on font sizes and page layout constraints
 */
const PAGE_CAPACITIES: Record<string, PageCapacity> = {
  'children-0-2': {
    // Extrapolated from children-3-6 (larger font, less content)
    firstPage: 400,
    fullPage: 600
  },
  'children-3-6': {
    firstPage: 565,
    fullPage: 800
  },
  'children-7-10': {
    firstPage: 1030,
    fullPage: 1300
  },
  'children-11-14': {
    firstPage: 1255,
    fullPage: 1657
  },
  'young-adult-15-17': {
    firstPage: 1480,
    fullPage: 2014
  },
  'adult-18-plus': {
    firstPage: 1860,
    fullPage: 2270
  },
  'all-ages': {
    firstPage: 1480,
    fullPage: 2014
  }
};

/**
 * Strip HTML tags from content and return plain text
 */
function stripHtmlTags(content: string): string {
  return content
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/&nbsp;/g, ' ') // Replace &nbsp; with regular spaces
    .replace(/&amp;/g, '&')  // Replace &amp; with &
    .replace(/&lt;/g, '<')   // Replace &lt; with <
    .replace(/&gt;/g, '>')   // Replace &gt; with >
    .replace(/&quot;/g, '"') // Replace &quot; with "
    .replace(/&#39;/g, "'")  // Replace &#39; with '
    .trim();
}

/**
 * Estimate the number of pages needed for chapter content
 * @param content The chapter content (may contain HTML)
 * @param targetAudience The target audience (e.g., 'children-3-6')
 * @returns Number of pages needed (always rounded up)
 */
export function estimateChapterPages(content: string, targetAudience?: string): number {
  // Default to all-ages if no target audience specified
  const audience = targetAudience || 'all-ages';
  
  // Normalize target audience key (replace underscores with hyphens)
  const normalizedAudience = audience.replace(/_/g, '-');
  
  // Get page capacity for this audience
  const capacity = PAGE_CAPACITIES[normalizedAudience];
  
  if (!capacity) {
    console.warn(`Unknown target audience: ${normalizedAudience}, using all-ages default`);
    return estimateChapterPages(content, 'all-ages');
  }
  
  // Strip HTML tags and count characters
  const plainText = stripHtmlTags(content);
  const totalChars = plainText.length;
  
  if (totalChars === 0) {
    return 1; // Minimum one page even for empty content
  }
  
  // Calculate pages needed
  if (totalChars <= capacity.firstPage) {
    // Content fits on first page
    return 1;
  } else {
    // Content needs multiple pages
    const remainingChars = totalChars - capacity.firstPage;
    const additionalPages = Math.ceil(remainingChars / capacity.fullPage);
    return 1 + additionalPages;
  }
}

/**
 * Calculate total pages needed for all chapters and determine blank page insertions
 * @param chapters Array of chapter objects with content and imageUri
 * @param targetAudience The target audience
 * @returns Object with page calculations and blank page positions
 */
export function calculateChapterLayout(chapters: any[], targetAudience?: string) {
  let currentPage = 6; // Start after the 5 initial pages (title, copyright, dedication, synopsis, TOC)
  const chapterLayouts: Array<{
    chapterIndex: number;
    needsBlankPage: boolean;
    imagePageNumber: number;
    contentStartPage: number;
    contentPages: number;
    contentEndPage: number;
  }> = [];
  
  chapters.forEach((chapter, index) => {
    // Check if we need a blank page to get to an even page for the image
    const needsBlankPage = currentPage % 2 !== 0; // If current page is odd, we need a blank page
    
    if (needsBlankPage) {
      currentPage++; // Add blank page
    }
    
    // Chapter image is on current page (should be even)
    const imagePageNumber = currentPage;
    currentPage++; // Move to next page for content
    
    // Chapter content starts on current page (should be odd)
    const contentStartPage = currentPage;
    
    // Estimate how many pages the content will take
    const contentPages = estimateChapterPages(chapter.content, targetAudience);
    const contentEndPage = contentStartPage + contentPages - 1;
    
    chapterLayouts.push({
      chapterIndex: index,
      needsBlankPage,
      imagePageNumber,
      contentStartPage,
      contentPages,
      contentEndPage
    });
    
    // Update current page for next chapter
    currentPage = contentEndPage + 1;
  });
  
  return {
    layouts: chapterLayouts,
    totalPages: currentPage,
    finalPageIsOdd: (currentPage - 1) % 2 !== 0
  };
}

/**
 * Debug function to log page layout information
 */
export function debugPageLayout(chapters: any[], targetAudience?: string) {
  const layout = calculateChapterLayout(chapters, targetAudience);
  
  console.log(`\n=== Page Layout Debug (Target: ${targetAudience}) ===`);
  console.log(`Initial pages: 1-5 (title, copyright, dedication, synopsis, TOC)`);
  
  layout.layouts.forEach(({ chapterIndex, needsBlankPage, imagePageNumber, contentStartPage, contentPages, contentEndPage }) => {
    console.log(`\nChapter ${chapterIndex + 1}:`);
    if (needsBlankPage) {
      console.log(`  - Blank page: ${imagePageNumber - 1}`);
    }
    console.log(`  - Image page: ${imagePageNumber} (${imagePageNumber % 2 === 0 ? 'EVEN' : 'ODD'})`);
    console.log(`  - Content pages: ${contentStartPage}-${contentEndPage} (${contentPages} pages)`);
  });
  
  console.log(`\nTotal pages: ${layout.totalPages}`);
  console.log(`Final page is: ${layout.finalPageIsOdd ? 'ODD' : 'EVEN'}`);
  console.log(`=== End Debug ===\n`);
}
