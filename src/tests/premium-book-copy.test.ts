import { randomUUID } from 'node:crypto';
import { copyPremiumManifest } from '../services/premium-book-copy.js';
import { premiumLetteredManifestFixture } from './fixtures/premium-book.js';

it('copies the complete online edition to its own protected object prefix', async () => {
  const source = premiumLetteredManifestFixture();
  const id = randomUUID(),
    revision = randomUUID();
  const copy = await copyPremiumManifest(source, id, revision, async (ref) => ({
    ...ref,
    key: id + '/premium/revisions/' + revision + '/assets/' + ref.key.split('/').pop(),
  }));
  expect(copy.pages.map((p) => p.text)).toEqual(source.pages.map((p) => p.text));
  expect(copy.specification).toEqual(source.specification);
  expect(copy.previousRevision).toBeUndefined();
  expect(JSON.stringify(copy)).not.toContain(source.storyId + '/premium/');
  expect(copy.reference.key).toContain(id + '/premium/');
  expect(source.reference.key).toContain(source.storyId + '/premium/');
});
