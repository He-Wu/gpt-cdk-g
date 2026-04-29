const { readAllJsonData } = require('./json-data');

const CARD_COLUMNS = [
  'id',
  'code',
  'type',
  'status',
  'created_at',
  'used_at',
  'used_by',
  'used_email',
  'batch_id',
  'created_by_username',
  'created_by_role',
  'cost',
  'sale_price',
  'remark',
  'issue_type',
  'compensated_at',
  'compensation_batch_id',
  'compensation_code',
  'compensation_for_code',
  'compensation_reason',
  'replaced_at',
  'replaced_by_code',
  'replaced_from_code',
  'replacement_batch_id'
];

const RECORD_COLUMNS = [
  'id',
  'card_code',
  'card_type',
  'access_token_hash',
  'job_id',
  'status',
  'error_message',
  'created_at',
  'ip_address',
  'email',
  'estimated_wait_seconds',
  'queue_position',
  'upstream_detail',
  'upstream_status_code',
  'workflow',
  'needs_manual_review',
  'manual_review_reason',
  'manual_review_stage',
  'manual_resolution',
  'manual_resolved_at',
  'manual_resolved_by',
  'created_by_username',
  'created_by_role'
];

const COST_RECORD_COLUMNS = [
  'id',
  'record_type',
  'card_type',
  'quantity',
  'total_cost',
  'unit_cost',
  'supplier',
  'remark',
  'created_at',
  'created_by_username',
  'created_by_role'
];

function splitKnownAndExtra(source, columns) {
  const row = {};
  const extra = {};
  const known = new Set(columns);
  for (const column of columns) row[column] = source[column] ?? null;
  for (const [key, value] of Object.entries(source || {})) {
    if (!known.has(key)) extra[key] = value;
  }
  row.extra = extra;
  return row;
}

function mergeRowAndExtra(row, columns) {
  const output = {};
  for (const column of columns) {
    if (typeof row[column] !== 'undefined' && row[column] !== null) output[column] = row[column];
  }
  return { ...output, ...(row.extra || {}) };
}

function mapCardToRow(card) {
  return splitKnownAndExtra(card || {}, CARD_COLUMNS);
}

function mapRowToCard(row) {
  return mergeRowAndExtra(row || {}, CARD_COLUMNS);
}

function mapRecordToRow(record) {
  return splitKnownAndExtra(record || {}, RECORD_COLUMNS);
}

function mapRowToRecord(row) {
  return mergeRowAndExtra(row || {}, RECORD_COLUMNS);
}

function mapCostRecordToRow(record) {
  return splitKnownAndExtra(record || {}, COST_RECORD_COLUMNS);
}

function mapRowToCostRecord(row) {
  return mergeRowAndExtra(row || {}, COST_RECORD_COLUMNS);
}

function makePlaceholders(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => `$${index + 1 + offset}`).join(', ');
}

function buildUpsertSql(table, columns, conflictTarget) {
  const allColumns = [...columns, 'extra'];
  const insertSql = `
    INSERT INTO ${table} (${allColumns.join(', ')})
    VALUES (${makePlaceholders(allColumns.length)})
  `;
  if (!conflictTarget) return insertSql;
  const assignments = allColumns
    .filter((column) => column !== conflictTarget)
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(', ');
  return `${insertSql} ON CONFLICT (${conflictTarget}) DO UPDATE SET ${assignments}`;
}

function serializeJsonbValue(value) {
  if (value === null || typeof value === 'undefined') return null;
  return JSON.stringify(value);
}

function rowValues(row, columns, jsonbColumns = []) {
  const jsonbSet = new Set(jsonbColumns);
  return [
    ...columns.map((column) => (
      jsonbSet.has(column)
        ? serializeJsonbValue(row[column])
        : (row[column] ?? null)
    )),
    serializeJsonbValue(row.extra || {})
  ];
}

async function queryMany(client, table, columns, mapper, items, conflictTarget, jsonbColumns = []) {
  const sql = buildUpsertSql(table, columns, conflictTarget);
  for (const item of items) {
    const row = mapper(item);
    await client.query(sql, rowValues(row, columns, jsonbColumns));
  }
}

function requirePgPool(connectionString) {
  const { Pool } = require('pg');
  return new Pool({ connectionString });
}

function createPostgresStore({ connectionString, dataDir, logger = console, pool = null } = {}) {
  const db = pool || requirePgPool(connectionString);

  async function ensureSchema(client = db) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS cards (
        id bigint PRIMARY KEY,
        code text UNIQUE NOT NULL,
        type text,
        status text,
        created_at text,
        used_at text,
        used_by text,
        used_email text,
        batch_id text,
        created_by_username text,
        created_by_role text,
        cost numeric,
        sale_price numeric,
        remark text,
        issue_type text,
        compensated_at text,
        compensation_batch_id text,
        compensation_code text,
        compensation_for_code text,
        compensation_reason text,
        replaced_at text,
        replaced_by_code text,
        replaced_from_code text,
        replacement_batch_id text,
        extra jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS redeem_records (
        record_key bigserial PRIMARY KEY,
        id bigint,
        card_code text,
        card_type text,
        access_token_hash text,
        job_id text,
        status text,
        error_message text,
        created_at text,
        ip_address text,
        email text,
        estimated_wait_seconds numeric,
        queue_position integer,
        upstream_detail jsonb,
        upstream_status_code integer,
        workflow text,
        needs_manual_review boolean,
        manual_review_reason text,
        manual_review_stage text,
        manual_resolution text,
        manual_resolved_at text,
        manual_resolved_by text,
        created_by_username text,
        created_by_role text,
        extra jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id integer PRIMARY KEY DEFAULT 1,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS cost_records (
        id text PRIMARY KEY,
        record_type text,
        card_type text,
        quantity numeric,
        total_cost numeric,
        unit_cost numeric,
        supplier text,
        remark text,
        created_at text,
        created_by_username text,
        created_by_role text,
        extra jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS migration_runs (
        id bigserial PRIMARY KEY,
        source text NOT NULL,
        status text NOT NULL,
        cards_count integer NOT NULL DEFAULT 0,
        records_count integer NOT NULL DEFAULT 0,
        settings_count integer NOT NULL DEFAULT 0,
        cost_records_count integer NOT NULL DEFAULT 0,
        message text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      ALTER TABLE redeem_records DROP CONSTRAINT IF EXISTS redeem_records_pkey
    `);
    await client.query(`
      ALTER TABLE redeem_records ADD COLUMN IF NOT EXISTS record_key bigserial
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'redeem_records'::regclass
            AND contype = 'p'
        ) THEN
          ALTER TABLE redeem_records ADD PRIMARY KEY (record_key);
        END IF;
      END
      $$
    `);
    await client.query(`
      ALTER TABLE redeem_records
      ALTER COLUMN estimated_wait_seconds TYPE numeric
      USING estimated_wait_seconds::numeric
    `);
  }

  async function loadAll() {
    const [cardsRes, recordsRes, settingsRes, costRecordsRes] = await Promise.all([
      db.query('SELECT * FROM cards ORDER BY id ASC'),
      db.query('SELECT * FROM redeem_records ORDER BY id ASC, record_key ASC'),
      db.query('SELECT data FROM settings WHERE id = 1'),
      db.query('SELECT * FROM cost_records ORDER BY created_at DESC, id ASC')
    ]);
    return {
      cards: cardsRes.rows.map(mapRowToCard),
      records: recordsRes.rows.map(mapRowToRecord),
      settings: settingsRes.rows[0]?.data || {},
      costRecords: costRecordsRes.rows.map(mapRowToCostRecord)
    };
  }

  async function withTransaction(callback) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch((rollbackErr) => {
        logger.error('PostgreSQL rollback failed:', rollbackErr);
      });
      throw err;
    } finally {
      client.release();
    }
  }

  async function saveCards(cards) {
    await withTransaction(async (client) => {
      await client.query('DELETE FROM cards');
      await queryMany(client, 'cards', CARD_COLUMNS, mapCardToRow, cards, 'id');
    });
  }

  async function saveRecords(records) {
    await withTransaction(async (client) => {
      await client.query('DELETE FROM redeem_records');
      await queryMany(client, 'redeem_records', RECORD_COLUMNS, mapRecordToRow, records, null, ['upstream_detail']);
    });
  }

  async function saveSettings(settings) {
    await db.query(
      `
        INSERT INTO settings (id, data, updated_at)
        VALUES (1, $1, now())
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
      `,
      [JSON.stringify(settings || {})]
    );
  }

  async function saveCostRecords(costRecords) {
    await withTransaction(async (client) => {
      await client.query('DELETE FROM cost_records');
      await queryMany(client, 'cost_records', COST_RECORD_COLUMNS, mapCostRecordToRow, costRecords, 'id');
    });
  }

  async function migrateJsonToPostgres() {
    if (!dataDir) throw new Error('dataDir is required for JSON migration');
    const jsonData = await readAllJsonData(dataDir);
    return withTransaction(async (client) => {
      await ensureSchema(client);
      await client.query('DELETE FROM cards');
      await client.query('DELETE FROM redeem_records');
      await client.query('DELETE FROM cost_records');
      await queryMany(client, 'cards', CARD_COLUMNS, mapCardToRow, jsonData.cards, 'id');
      await queryMany(client, 'redeem_records', RECORD_COLUMNS, mapRecordToRow, jsonData.records, null, ['upstream_detail']);
      await client.query(
        `
          INSERT INTO settings (id, data, updated_at)
          VALUES (1, $1, now())
          ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
        `,
        [JSON.stringify(jsonData.settings || {})]
      );
      await queryMany(client, 'cost_records', COST_RECORD_COLUMNS, mapCostRecordToRow, jsonData.costRecords, 'id');

      const counts = {
        source: 'json',
        status: 'success',
        cards_count: jsonData.cards.length,
        records_count: jsonData.records.length,
        settings_count: Object.keys(jsonData.settings || {}).length > 0 ? 1 : 0,
        cost_records_count: jsonData.costRecords.length,
        message: 'JSON data migrated to PostgreSQL'
      };
      await client.query(
        `
          INSERT INTO migration_runs
            (source, status, cards_count, records_count, settings_count, cost_records_count, message)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          counts.source,
          counts.status,
          counts.cards_count,
          counts.records_count,
          counts.settings_count,
          counts.cost_records_count,
          counts.message
        ]
      );
      return counts;
    });
  }

  async function getMigrationStatus() {
    const result = await db.query('SELECT * FROM migration_runs ORDER BY created_at DESC, id DESC LIMIT 1');
    return result.rows[0] || null;
  }

  return {
    close: () => db.end(),
    connect: () => db.query('SELECT 1'),
    ensureSchema,
    getMigrationStatus,
    loadAll,
    migrateJsonToPostgres,
    saveCards,
    saveCostRecords,
    saveRecords,
    saveSettings
  };
}

module.exports = {
  createPostgresStore,
  mapCardToRow,
  mapCostRecordToRow,
  mapRecordToRow,
  mapRowToCard,
  mapRowToCostRecord,
  mapRowToRecord
};
