import { z } from 'zod';

const searchResult = z.object({
  web: z
    .object({
      results: z.array(
        z.object({ url: z.string().url(), title: z.string(), description: z.string().optional() }),
      ),
    })
    .optional(),
});
/** Queries contain ONLY creator-confirmed public place/era labels, never transcripts or private identities. */
export async function researchPlaces(places: string[], period?: string) {
  if (
    process.env.BIOGRAPHER_RESEARCH_ENTITLEMENT_CONFIRMED !== 'true' ||
    !process.env.BRAVE_SEARCH_API_KEY
  )
    throw new Error('BIOGRAPHER_RESEARCH_NOT_CONFIGURED');
  if (!places.length) throw new Error('BIOGRAPHER_PUBLIC_PLACE_REQUIRED');
  const evidence: Array<{ url: string; title: string; text: string; retrievedAt: string }> = [];
  for (const place of places.slice(0, 5)) {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', `${place} ${period ?? ''} local history culture official archive`);
    url.searchParams.set('count', '5');
    const response = await fetch(url, {
      headers: {
        'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('BIOGRAPHER_RESEARCH_UNAVAILABLE');
    const parsed = searchResult.parse(await response.json());
    for (const item of parsed.web?.results ?? []) {
      // Only retain provider-licensed snippets. No scraping, copied page prose or private search queries.
      if (item.description)
        evidence.push({
          url: item.url,
          title: item.title,
          text: item.description,
          retrievedAt: new Date().toISOString(),
        });
    }
  }
  if (!evidence.length) throw new Error('BIOGRAPHER_RESEARCH_NO_EVIDENCE');
  return evidence;
}
