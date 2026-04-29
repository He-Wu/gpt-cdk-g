# PostgreSQL Data Source Migration Design

Date: 2026-04-29

## Goal

Move the project from JSON-file persistence in `data/*.json` to PostgreSQL running on the same server through Docker. Existing JSON data remains as a backup. A super-admin-only button in the admin UI performs the one-time migration from JSON into PostgreSQL.

## Current State

The application stores persistent data in four JSON files:

- `data/cards.json`
- `data/records.json`
- `data/settings.json`
- `data/cost-records.json`

`server.js` loads these files into in-memory arrays or objects at startup. Runtime changes update memory and then rewrite the whole JSON file through `saveCards`, `saveRecords`, `saveSettings`, and `saveCostRecords`.

## Target Architecture

PostgreSQL becomes the application's authoritative data source.

The Docker deployment adds a `postgres` service in the same `docker-compose.yml`. The app connects through `DATABASE_URL`, using the internal compose hostname `postgres`.

The app ensures required tables exist on startup. Startup does not import JSON data automatically. The admin migration button performs JSON import explicitly.

After migration, normal application reads and writes use PostgreSQL. The original JSON files are left untouched as backup inputs.

## Database Model

The schema keeps the current application model stable and avoids changing public API responses.

### `cards`

Stores card records.

Important columns:

- `id bigint primary key`
- `code text unique not null`
- `type text not null`
- `status text not null`
- `created_at text`
- `used_at text`
- `used_by text`
- `used_email text`
- `batch_id text`
- `created_by_username text`
- `created_by_role text`
- `cost numeric`
- `sale_price numeric`
- `remark text`
- `issue_type text`
- compensation and replacement fields as nullable text columns
- `extra jsonb not null default '{}'::jsonb`

`extra` preserves any future fields not explicitly mapped.

### `redeem_records`

Stores redemption records.

Important columns:

- `id bigint primary key`
- `card_code text not null`
- `card_type text`
- `access_token_hash text`
- `job_id text`
- `status text not null`
- `error_message text`
- `created_at text`
- `ip_address text`
- `email text`
- queue, upstream, manual-review, workflow, and creator fields as nullable columns
- `extra jsonb not null default '{}'::jsonb`

### `settings`

Stores the full settings object as JSON.

Important columns:

- `id integer primary key default 1`
- `data jsonb not null`
- `updated_at timestamptz not null default now()`

The single-row JSON shape preserves existing settings behavior, including sub-admins, maintenance, notices, and API configuration.

### `cost_records`

Stores cost records.

Important columns:

- `id text primary key`
- `record_type text not null`
- `card_type text not null`
- `quantity numeric not null`
- `total_cost numeric not null`
- `unit_cost numeric`
- `supplier text`
- `remark text`
- `created_at text`
- `created_by_username text`
- `created_by_role text`
- `extra jsonb not null default '{}'::jsonb`

### `migration_runs`

Stores migration audit records.

Important columns:

- `id bigserial primary key`
- `source text not null`
- `status text not null`
- `cards_count integer not null default 0`
- `records_count integer not null default 0`
- `settings_count integer not null default 0`
- `cost_records_count integer not null default 0`
- `message text`
- `created_at timestamptz not null default now()`

## Data Access Design

Add a small PostgreSQL-backed store layer rather than changing every route directly.

The existing runtime variables remain:

- `cards`
- `records`
- `settings`
- `costRecords`

At startup, the app initializes the database schema and loads these values from PostgreSQL. Save functions persist the current in-memory state back to PostgreSQL:

- `saveCards(cards)`
- `saveRecords(records)`
- `saveSettings(settings)`
- `saveCostRecords(costRecords)`

This keeps route behavior stable while replacing persistence. It also limits changes in the large existing `server.js`.

## Migration Flow

The new endpoint is:

`POST /api/admin/migrate-json-to-postgres`

Access rules:

- Requires admin authentication.
- Requires super admin permission.

Behavior:

1. Ensure PostgreSQL schema exists.
2. Read the four JSON files from `data/`.
3. Normalize data using existing normalization helpers where applicable.
4. Upsert all rows in a single transaction.
5. Reload in-memory state from PostgreSQL after commit.
6. Record a `migration_runs` entry.
7. Return counts and migration status to the UI.

The migration is idempotent. Re-clicking the button updates existing rows by primary key or unique key instead of duplicating them.

If any import step fails, the transaction rolls back and the app keeps its previous in-memory state.

## Admin UI

Add a super-admin-only migration panel to the system status or system settings page.

The panel shows:

- Current data source: PostgreSQL.
- Last migration status if available.
- A button labeled `迁移 JSON 数据到数据库`.
- Success counts after completion.
- A warning that JSON files are retained as backup and are not deleted.

The button calls `POST /api/admin/migrate-json-to-postgres` through the existing `adminFetch` helper.

## Docker Deployment

`docker-compose.yml` adds:

- `postgres` service using an official PostgreSQL image.
- Persistent PostgreSQL volume.
- App dependency on PostgreSQL.
- App `DATABASE_URL`.

`.env.example` documents database variables:

- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `DATABASE_URL`

The app and database run on the same Docker network. PostgreSQL does not need to publish a public port.

## Error Handling

If `DATABASE_URL` is missing, the app exits with a clear startup error in production-oriented Docker mode.

If PostgreSQL is unreachable, startup fails fast instead of silently writing JSON.

Migration errors return a JSON error response and are logged server-side.

## Testing

Add tests for:

- Migration endpoint requires super admin.
- Migration imports JSON cards, records, settings, and cost records.
- Migration is idempotent.
- Save functions persist changes to PostgreSQL.
- Docker and env configuration include PostgreSQL wiring.

Tests use a PostgreSQL test database when available. Unit-level serialization tests cover row mapping without requiring a live database.

