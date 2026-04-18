# AGENTS.md

## Scope

Database connections, schema sync, and migration workflows under `src/db`.

## Database inventory

### Mythoria story database (`DB_NAME` / `mythoria_db`)

- The default connection created by `getDatabase()` wraps a shared PostgreSQL pool with Drizzle and pulls host, port, user, password, and database from `getDatabaseConfig()` (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`).
- Schema files under `src/db/schema` are read-only mirrors of the `mythoria-webapp` project; they are refreshed via the sync scripts instead of being edited in-place.
- Ownership: the Mythoria webapp team maintains schema changes and migrations—this service only consumes the generated artifacts (`npm run db:migrate`/`db:push` expect the adjacent `../mythoria-webapp/drizzle` directory).

### Workflow metadata database (`WORKFLOWS_DB`)

- `getWorkflowsDatabase()` provisions a second Drizzle instance targeting the workflow run metadata schema (`story_generation_runs`, `story_generation_steps`, `token_usage_tracking`) stored in `src/db/workflows-schema`.
- This pool reuses the primary database host credentials but requires its own `WORKFLOWS_DB` name and intentionally disables SSL.
- Ownership: the Story Generation Workflow team owns this database—the migrations and schema live in-repo (`drizzle-workflows/`), and the `workflows-db:*` scripts operate solely from this codebase.

## Connection helpers

- Import `getDatabase()` / `closeDatabaseConnection()` / `schema` from `src/db/connection` for story data access; do not new up additional `pg.Pool` instances.
- Import `getWorkflowsDatabase()` / `closeWorkflowsDatabaseConnection()` from `src/db/workflows-db` whenever you need workflow run state or token usage records.

## Schema maintenance

- Do **not** edit files under `src/db/schema` directly. Run `npm run schema:sync` (or its variants) to refresh them from `mythoria-webapp`, and coordinate schema changes with that team first.
- Use the `workflows-db:*` scripts (`generate`, `migrate`, `push`, `studio`) when evolving workflow metadata tables; the migrations are checked into `drizzle-workflows/` alongside this service.
- Avoid introducing cross-database foreign keys—`story_generation_runs.story_id` intentionally stays unenforced so it can reference records from the external Mythoria database.
