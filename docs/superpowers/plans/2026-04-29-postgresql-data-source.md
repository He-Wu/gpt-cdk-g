# PostgreSQL Data Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace JSON-file persistence with PostgreSQL and add a super-admin button to migrate existing JSON data into the database.

**Architecture:** Add focused database modules under `lib/` and keep existing route behavior in `server.js` stable. The app initializes PostgreSQL on startup, loads runtime state from PostgreSQL, and exposes an authenticated migration endpoint that imports `data/*.json` through an idempotent transaction.

**Tech Stack:** Node.js CommonJS, Express, `pg`, PostgreSQL, Docker Compose, Node test runner.

---

## File Structure

- Create `lib/postgres-store.js`: PostgreSQL schema creation, row mapping, load/save methods, migration transaction, migration status.
- Create `lib/json-data.js`: JSON file readers used by the migration endpoint and tests.
- Modify `server.js`: initialize PostgreSQL before `app.listen`, replace JSON save/load implementation with store calls, add migration and status endpoints, add datasource info to system output.
- Modify `admin.html`: add migration panel and JavaScript handlers.
- Modify `package.json` and `pnpm-lock.yaml`: add `pg`.
- Modify `docker-compose.yml`, `docker-compose.staging.yml`, `.env.example`: add PostgreSQL service and database env vars.
- Modify `tests/security.test.js`: add PostgreSQL-aware tests that mock `pg` for unit-level migration behavior and keep existing fixture copying valid.

## Task 1: PostgreSQL Store Module

**Files:**
- Create: `lib/postgres-store.js`
- Create: `lib/json-data.js`
- Test: `tests/postgres-store.test.js`

- [ ] **Step 1: Write failing mapper and migration tests**

Create `tests/postgres-store.test.js` with tests that import `mapCardToRow`, `mapRowToCard`, `readJsonData`, and `createPostgresStore`. Use a fake client object to assert that migration upserts rows and is idempotent at the SQL-call level.

Run: `node --test tests/postgres-store.test.js`
Expected: FAIL because the files do not exist.

- [ ] **Step 2: Implement JSON reader**

Create `lib/json-data.js` exporting `readJsonFile`, `readJsonArray`, `readJsonObject`, and `readAllJsonData`. Missing array files return `[]`; missing settings returns `{}`; invalid JSON throws a clear error naming the file.

- [ ] **Step 3: Implement PostgreSQL store**

Create `lib/postgres-store.js` exporting:

- `createPostgresStore({ connectionString, dataDir, logger })`
- `mapCardToRow(card)`
- `mapRowToCard(row)`
- `mapRecordToRow(record)`
- `mapRowToRecord(row)`
- `mapCostRecordToRow(record)`
- `mapRowToCostRecord(row)`

The store methods are:

- `connect()`
- `close()`
- `ensureSchema()`
- `loadAll()`
- `saveCards(cards)`
- `saveRecords(records)`
- `saveSettings(settings)`
- `saveCostRecords(costRecords)`
- `migrateJsonToPostgres()`
- `getMigrationStatus()`

Use parameterized SQL only. Use `jsonb` for `extra` fields and settings data.

- [ ] **Step 4: Run store tests**

Run: `node --test tests/postgres-store.test.js`
Expected: PASS.

## Task 2: Server Integration

**Files:**
- Modify: `server.js`
- Test: `tests/security.test.js`

- [ ] **Step 1: Write failing integration tests**

Add tests that start the server with `DATABASE_URL` unset and with `DATA_SOURCE=json` to confirm test fixtures still run. Add tests for the migration endpoint authentication and response shape using a mocked store mode.

Run: `node --test --test-name-pattern "migration|data source" tests/security.test.js`
Expected: FAIL because endpoints and data-source behavior are missing.

- [ ] **Step 2: Wire data source initialization**

In `server.js`, require `createPostgresStore`. Add:

- `DATA_SOURCE = process.env.DATA_SOURCE || (process.env.DATABASE_URL ? 'postgres' : 'json')`
- A `store` variable when PostgreSQL is enabled.
- Async `bootstrap()` that initializes schema and loads state before `app.listen`.

Keep JSON fallback only for local tests and explicit `DATA_SOURCE=json`; Docker defaults to PostgreSQL by setting `DATABASE_URL`.

- [ ] **Step 3: Replace persistence functions**

Update `saveCards`, `saveRecords`, `saveSettings`, and `saveCostRecords` to persist through PostgreSQL when `store` exists. Keep synchronous in-memory route behavior and queue async persistence with error logging.

- [ ] **Step 4: Add migration endpoints**

Add:

- `GET /api/admin/migration-status`
- `POST /api/admin/migrate-json-to-postgres`

Both require super admin. The POST endpoint calls `store.migrateJsonToPostgres()`, reloads runtime state, and returns counts.

- [ ] **Step 5: Run integration tests**

Run: `node --test --test-name-pattern "migration|data source" tests/security.test.js`
Expected: PASS.

## Task 3: Admin UI Migration Button

**Files:**
- Modify: `admin.html`
- Test: `tests/security.test.js`

- [ ] **Step 1: Write failing static UI test**

Add a test that reads `admin.html` and asserts it contains:

- `migrateJsonToPostgres`
- `/api/admin/migrate-json-to-postgres`
- `迁移 JSON 数据到数据库`

Run: `node --test --test-name-pattern "migration ui" tests/security.test.js`
Expected: FAIL.

- [ ] **Step 2: Add system page migration panel**

In the system status page, add a super-admin-only panel with:

- Current data source display.
- Last migration status display.
- Button text `迁移 JSON 数据到数据库`.
- Warning that JSON remains as backup.

- [ ] **Step 3: Add UI handlers**

Add `loadMigrationStatus()` and `migrateJsonToPostgres()` using `adminFetch`. Refresh status after a successful migration.

- [ ] **Step 4: Run UI test**

Run: `node --test --test-name-pattern "migration ui" tests/security.test.js`
Expected: PASS.

## Task 4: Docker and Environment

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.staging.yml`
- Modify: `.env.example`

- [ ] **Step 1: Write failing config test**

Add a static test asserting:

- `package.json` includes `pg`.
- `docker-compose.yml` includes `postgres`, `POSTGRES_DB`, and `DATABASE_URL`.
- `.env.example` documents `POSTGRES_PASSWORD`.

Run: `node --test --test-name-pattern "postgres docker config" tests/security.test.js`
Expected: FAIL.

- [ ] **Step 2: Add dependency**

Add `pg` to `package.json` dependencies and update `pnpm-lock.yaml` with `pnpm install`.

- [ ] **Step 3: Update compose files**

Add a `postgres` service, volume, `DATABASE_URL`, and `depends_on` to compose files. Do not publish PostgreSQL ports publicly.

- [ ] **Step 4: Update env example**

Document database settings and keep existing admin settings.

- [ ] **Step 5: Run config test**

Run: `node --test --test-name-pattern "postgres docker config" tests/security.test.js`
Expected: PASS.

## Task 5: Full Verification

**Files:**
- All changed files

- [ ] **Step 1: Run focused tests**

Run: `node --test tests/postgres-store.test.js`
Expected: PASS.

- [ ] **Step 2: Run existing security tests**

Run: `node --test tests/security.test.js`
Expected: PASS.

- [ ] **Step 3: Run package build/install verification**

Run: `pnpm install --frozen-lockfile`
Expected: PASS and lockfile unchanged.

- [ ] **Step 4: Review diff**

Run: `git diff --check` and `git status --short`
Expected: no whitespace errors; only intended files changed.

