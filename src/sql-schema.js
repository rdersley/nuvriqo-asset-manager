import { migrationRunner } from '@forge/sql';

const CREATE_ASSETS = `CREATE TABLE IF NOT EXISTS Assets (
  id VARCHAR(96) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  normalized_name VARCHAR(255) NOT NULL,
  jira_identifier VARCHAR(255),
  normalized_identifier VARCHAR(255),
  jira_identifier_field_id VARCHAR(64),
  jira_identifier_field_name VARCHAR(255),
  assignment_reference VARCHAR(255),
  assignee_account_id VARCHAR(255),
  assignee_name VARCHAR(255),
  device_type VARCHAR(128),
  manufacturer VARCHAR(128),
  model VARCHAR(128),
  serial_number VARCHAR(255),
  status VARCHAR(64),
  location VARCHAR(255),
  purchase_date VARCHAR(32),
  warranty_expiry VARCHAR(32),
  notes TEXT,
  custom_fields JSON,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  source_hash VARCHAR(64),
  INDEX idx_assets_normalized_name (normalized_name),
  INDEX idx_assets_normalized_identifier (normalized_identifier),
  INDEX idx_assets_type (device_type),
  INDEX idx_assets_location (location),
  INDEX idx_assets_assignment (assignment_reference),
  INDEX idx_assets_serial (serial_number),
  INDEX idx_assets_status (status),
  INDEX idx_assets_updated (updated_at)
)`;

const CREATE_ASSET_HISTORY = `CREATE TABLE IF NOT EXISTS AssetHistory (
  event_id VARCHAR(96) PRIMARY KEY,
  asset_id VARCHAR(96) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  source VARCHAR(64),
  issue_key VARCHAR(64),
  message VARCHAR(1024),
  changes_json JSON,
  occurred_at DATETIME(3) NOT NULL,
  INDEX idx_history_asset_time (asset_id, occurred_at),
  INDEX idx_history_type_time (event_type, occurred_at),
  INDEX idx_history_issue (issue_key)
)`;

const CREATE_ISSUE_ASSET_LINKS = `CREATE TABLE IF NOT EXISTS IssueAssetLinks (
  link_id VARCHAR(160) PRIMARY KEY,
  issue_key VARCHAR(64) NOT NULL,
  asset_id VARCHAR(96) NOT NULL,
  relation_type VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_issue_links_issue (issue_key),
  INDEX idx_issue_links_asset (asset_id),
  INDEX idx_issue_links_relation (relation_type)
)`;

const CREATE_MIGRATION_STATE = `CREATE TABLE IF NOT EXISTS DataMigrationState (
  migration_key VARCHAR(96) PRIMARY KEY,
  status VARCHAR(32) NOT NULL,
  cursor_value VARCHAR(512),
  processed_count INT NOT NULL DEFAULT 0,
  migrated_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  last_error VARCHAR(1024),
  started_at DATETIME(3),
  updated_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3)
)`;

const CREATE_IMPORT_RUNS = `CREATE TABLE IF NOT EXISTS ImportRuns (
  run_id VARCHAR(96) PRIMARY KEY,
  import_type VARCHAR(64) NOT NULL,
  source_name VARCHAR(255),
  source_rows INT NOT NULL DEFAULT 0,
  processed_rows INT NOT NULL DEFAULT 0,
  created_count INT NOT NULL DEFAULT 0,
  updated_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,
  exception_count INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL,
  started_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3),
  INDEX idx_import_runs_type_time (import_type, started_at),
  INDEX idx_import_runs_status (status)
)`;

const CREATE_IMPORT_EXCEPTIONS = `CREATE TABLE IF NOT EXISTS ImportExceptions (
  exception_id VARCHAR(128) PRIMARY KEY,
  run_id VARCHAR(96) NOT NULL,
  row_key VARCHAR(255),
  exception_type VARCHAR(64) NOT NULL,
  message VARCHAR(1024),
  payload JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_import_exceptions_run (run_id),
  INDEX idx_import_exceptions_type (exception_type)
)`;

const migrations = migrationRunner
  .enqueue('v001_create_assets', CREATE_ASSETS)
  .enqueue('v002_create_asset_history', CREATE_ASSET_HISTORY)
  .enqueue('v003_create_issue_asset_links', CREATE_ISSUE_ASSET_LINKS)
  .enqueue('v004_create_data_migration_state', CREATE_MIGRATION_STATE)
  .enqueue('v005_create_import_runs', CREATE_IMPORT_RUNS)
  .enqueue('v006_create_import_exceptions', CREATE_IMPORT_EXCEPTIONS);

export const applySqlSchema = async () => {
  const applied = await migrations.run();
  console.log('Forge SQL schema migrations applied:', applied);
  return applied;
};

export const runSqlSchemaMigration = async () => {
  const deadline = Date.now() + 50000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await applySqlSchema();
    } catch (error) {
      lastError = error;
      console.warn('Forge SQL schema migration retry:', error?.message || error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw lastError || new Error('Forge SQL schema migration timed out.');
};
