import { relations } from "drizzle-orm";
import { authors, addresses, events } from './authors';
import { stories, storyVersions } from './stories';
import { characters, storyCharacters } from './characters';
import { creditLedger, authorCreditBalances } from './credits';
import { storyGenerationRuns, storyGenerationSteps } from './story-generation';

// -----------------------------------------------------------------------------
// Relations (for type safety with Drizzle ORM queries)
// Note: Excludes payment and shipping related relations
// -----------------------------------------------------------------------------

export const authorsRelations = relations(authors, ({ one, many }) => ({
  addresses: many(addresses),
  stories: many(stories),
  characters: many(characters), // Characters an author created directly
  events: many(events),
  creditLedgerEntries: many(creditLedger),
  creditBalance: one(authorCreditBalances, {
    fields: [authors.authorId],
    references: [authorCreditBalances.authorId],
  }),
}));

export const addressesRelations = relations(addresses, ({ one }) => ({
  author: one(authors, {
    fields: [addresses.authorId],
    references: [authors.authorId],
  }),
}));

export const storiesRelations = relations(stories, ({ one, many }) => ({
  author: one(authors, {
    fields: [stories.authorId],
    references: [authors.authorId],
  }),
  storyCharacters: many(storyCharacters),
  storyVersions: many(storyVersions),
  creditLedgerEntries: many(creditLedger),
  storyGenerationRuns: many(storyGenerationRuns),
}));

export const charactersRelations = relations(characters, ({ one, many }) => ({
  author: one(authors, { // If character is directly linked to an author
    fields: [characters.authorId],
    references: [authors.authorId],
  }),
  storyCharacters: many(storyCharacters),
}));

export const storyCharactersRelations = relations(storyCharacters, ({ one }) => ({
  story: one(stories, {
    fields: [storyCharacters.storyId],
    references: [stories.storyId],
  }),
  character: one(characters, {
    fields: [storyCharacters.characterId],
    references: [characters.characterId],
  }),
}));

export const storyVersionsRelations = relations(storyVersions, ({ one }) => ({
  story: one(stories, {
    fields: [storyVersions.storyId],
    references: [stories.storyId],
  }),
}));

export const eventsRelations = relations(events, ({ one }) => ({
  author: one(authors, {
    fields: [events.authorId],
    references: [authors.authorId],
  }),
}));

export const creditLedgerRelations = relations(creditLedger, ({ one }) => ({
  author: one(authors, {
    fields: [creditLedger.authorId],
    references: [authors.authorId],
  }),
  story: one(stories, {
    fields: [creditLedger.storyId],
    references: [stories.storyId],
  }),
}));

export const authorCreditBalancesRelations = relations(authorCreditBalances, ({ one }) => ({
  author: one(authors, {
    fields: [authorCreditBalances.authorId],
    references: [authors.authorId],
  }),
}));

// Story Generation Relations
export const storyGenerationRunsRelations = relations(storyGenerationRuns, ({ one, many }) => ({
  story: one(stories, {
    fields: [storyGenerationRuns.storyId],
    references: [stories.storyId],
  }),
  steps: many(storyGenerationSteps),
}));

export const storyGenerationStepsRelations = relations(storyGenerationSteps, ({ one }) => ({
  run: one(storyGenerationRuns, {
    fields: [storyGenerationSteps.runId],
    references: [storyGenerationRuns.runId],
  }),
}));
