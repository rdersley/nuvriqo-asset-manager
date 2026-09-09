import { migrationRunner } from '@forge/sql';

const CREATE_ASSETS = `CREATE TABLE IF NOT EXISTS Assets (
  id VARCHAR(96) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  normalized_name VARCHAR(255) NOT NULL,
  jira_identifier VARCHAR(255),
  normalized_identifier VARCHAR(255),
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
  INDEX idx_assets_name (normalized_name),
  INDEX idx_assets_identifier (normalized_identifier),
  INDEX idx_assets_type (device_type),
  INDEX idx_assets_location (location),
  INDEX idx_assets_assignment (assignment_reference),
  INDEX idx_assets_serial (serial_number),
  INDEX idx_assets_status (status)
)`;

const CREATE_CREW = `CREATE TABLE IF NOT EXISTS CrewMembers (
  crew_code VARCHAR(128) PRIMARY KEY,
  name VARCHAR(255),
  location VARCHAR(255),
  email VARCHAR(255),
  easysim_username VARCHAR(128),
  ryrwin_username VARCHAR(128),
  role VARCHAR(128),
  status VARCHAR(64),
  contract_end_date VARCHAR(32),
  training_end_date VARCHAR(32),
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_crew_easysim (easysim_username),
  INDEX idx_crew_ryrwin (ryrwin_username),
  INDEX idx_crew_email (email),
  INDEX idx_crew_location (location)
)`;

const CREATE_CUSTODY = `CREATE TABLE IF NOT EXISTS CustodyEvents (
  event_id VARCHAR(96) PRIMARY KEY,
  asset_id VARCHAR(96) NOT NULL,
  crew_code VARCHAR(128),
  device_type VARCHAR(128),
  event_type VARCHAR(64) NOT NULL,
  state VARCHAR(64) NOT NULL,
  source VARCHAR(64),
  issue_key VARCHAR(64),
  previous_crew_code VARCHAR(128),
  related_asset_id VARCHAR(96),
  expected_return_at DATETIME(3),
  actual_return_at DATETIME(3),
  notes VARCHAR(1024),
  occurred_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_custody_asset_time (asset_id, occurred_at),
  INDEX idx_custody_crew_type_state (crew_code, device_type, state),
  INDEX idx_custody_state (state),
  INDEX idx_custody_issue (issue_key)
)`;

const CREATE_HISTORY = `CREATE TABLE IF NOT EXISTS AssetHistory (
  event_id VARCHAR(96) PRIMARY KEY,
  asset_id VARCHAR(96) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  source VARCHAR(64),
  issue_key VARCHAR(64),
  message VARCHAR(1024),
  changes_json JSON,
  occurred_at DATETIME(3) NOT NULL,
  INDEX idx_history_asset_time (asset_id, occurred_at),
  INDEX idx_history_issue (issue_key)
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
  INDEX idx_import_type_time (import_type, started_at),
  INDEX idx_import_status (status)
)`;

const CREATE_IMPORT_EXCEPTIONS = `CREATE TABLE IF NOT EXISTS ImportExceptions (
  exception_id VARCHAR(128) PRIMARY KEY,
  run_id VARCHAR(96) NOT NULL,
  row_key VARCHAR(255),
  exception_type VARCHAR(64) NOT NULL,
  message VARCHAR(1024),
  payload JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_exception_run (run_id),
  INDEX idx_exception_type (exception_type)
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

const migrations = migrationRunner
  .enqueue('v001_create_assets', CREATE_ASSETS)
  .enqueue('v002_create_crew_members', CREATE_CREW)
  .enqueue('v003_create_custody_events', CREATE_CUSTODY)
  .enqueue('v004_create_asset_history', CREATE_HISTORY)
  .enqueue('v005_create_import_runs', CREATE_IMPORT_RUNS)
  .enqueue('v006_create_import_exceptions', CREATE_IMPORT_EXCEPTIONS)
  .enqueue('v007_create_data_migration_state', CREATE_MIGRATION_STATE);

export const applySqlSchema = async () => {
  const applied = await migrations.run();
  console.log('Internal Forge SQL schema migrations applied:', applied);
  return applied;
};

export const runSqlSchemaMigration = async () => {
  const deadline = Date.now() + 50000;
  let lastError;
  while (Date.now() < deadline) {
    try { return await applySqlSchema(); }
    catch (error) {
      lastError = error;
      console.warn('Internal Forge SQL schema migration retry:', error?.message || error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw lastError || new Error('Forge SQL schema migration timed out.');
};
