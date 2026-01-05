// -----------------------------------------------------------------------------
// Shared database schema - imports from mythoria-webapp
// This allows both applications to share the same database schema
// 
// Note: These are individual imports to avoid TypeScript compilation issues
// with cross-project references. Each schema is imported from the webapp.
// 
// Last synced: 2025-12-19 18:01:55
// -----------------------------------------------------------------------------

// Re-export schemas from mythoria-webapp (synced automatically)

export * from './enums.js';
export * from './authors.js';
export * from './stories.js';
export * from './characters.js';
export * from './credits.js';
export * from './pricing.js';
export * from './blog.js';
export * from './faq.js';
export * from './relations.js';

