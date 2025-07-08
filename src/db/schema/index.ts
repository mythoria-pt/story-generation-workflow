// -----------------------------------------------------------------------------
// Shared database schema - imports from mythoria-webapp
// This allows both applications to share the same database schema
// 
// Note: These are individual imports to avoid TypeScript compilation issues
// with cross-project references. Each schema is imported from the webapp.
// -----------------------------------------------------------------------------

// Re-export schemas from mythoria-webapp (temporarily copy approach)
// TODO: Consider using a shared package or workspace setup for better maintainability

export * from './enums.js';
export * from './authors.js';
export * from './stories.js';
export * from './characters.js';
export * from './credits.js';
export * from './pricing.js';
export * from './token-usage.js';
export * from './relations.js';
