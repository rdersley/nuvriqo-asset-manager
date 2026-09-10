import Resolver from '@forge/resolver';
import { kvs, WhereConditions } from '@forge/kvs';
import sql from '@forge/sql';
import { runSqlSchemaMigration } from './sql-schema.js';
import { assetSourceHash, getSqlAssetById, upsertSqlAsset } from './sql-storage.js';

const resolver = new Resolver();
const ASSET_PREFIX = 'asset:';
const MIGRATION_KEY = 'kvs-assets-to-sql-v1';
const VERIFY_SAMPLE_LIMIT = 50;
const nowSql = () => new Date().toISOString().slice(0, 23).replace('T', ' ');

async function getState() {
  const result = await sql.prepare('SELECT * FROM DataMigrationState WHERE migration_key = ? LIMIT 1').bindParams(MIGRATION_KEY).execute();
  return result.rows?.[0] || null;
}

async function saveState(state = {}) {
  const timestamp = nowSql();
  await sql.prepare(`INSERT INTO DataMigrationState (
    migration_key, status, cursor_value, processed_count, migrated_count, skipped_count, failed_count,
    last_error, started_at, updated_at, completed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    status = VALUES(status), cursor_value = VALUES(cursor_value), processed_count = VALUES(processed_count),
    migrated_count = VALUES(migrated_count), skipped_count = VALUES(skipped_count), failed_count = VALUES(failed_count),
    last_error = VALUES(last_error), updated_at = VALUES(updated_at), completed_at = VALUES(completed_at)`)
    .bindParams(MIGRATION_KEY,state.status || 'running',state.cursor_value || null,Number(state.processed_count || 0),Number(state.migrated_count || 0),Number(state.skipped_count || 0),Number(state.failed_count || 0),state.last_error || null,state.started_at || timestamp,timestamp,state.completed_at || null).execute();
}

async function nextAssetPage(cursor = null, limit = 100) {
  let query = kvs.query().where('key', WhereConditions.beginsWith(ASSET_PREFIX)).limit(Math.min(100, Math.max(1, Number(limit || 100))));
  if (cursor) query = query.cursor(cursor);
  return query.getMany();
}

async function countKvsAssets() {
  let count = 0;
  let cursor;
  do {
    const page = await nextAssetPage(cursor, 100);
    count += page.results?.length || 0;
    cursor = page.nextCursor;
  } while (cursor);
  return count;
}

async function verifySqlCopy() {
  const [state, sqlCountResult, kvsAssetCount] = await Promise.all([
    getState(),
    sql.prepare('SELECT COUNT(*) AS count FROM Assets').execute(),
    countKvsAssets()
  ]);
  const sqlAssetCount = Number(sqlCountResult.rows?.[0]?.count || 0);
  const sample = await nextAssetPage(null, VERIFY_SAMPLE_LIMIT);
  let sampled = 0, missing = 0, mismatched = 0;
  const examples = [];
  for (const entry of sample.results || []) {
    const asset = entry.value || {};
    if (!asset.id) continue;
    sampled += 1;
    const row = await getSqlAssetById(asset.id);
    if (!row) {
      missing += 1;
      if (examples.length < 5) examples.push({ id: asset.id, issue: 'missing-from-sql' });
      continue;
    }
    if (String(row.source_hash || '') !== assetSourceHash(asset)) {
      mismatched += 1;
      if (examples.length < 5) examples.push({ id: asset.id, issue: 'source-hash-mismatch' });
    }
  }
  const countsMatch = kvsAssetCount === sqlAssetCount;
  const migrationComplete = state?.status === 'complete';
  const readyForSqlReads = migrationComplete && countsMatch && missing === 0 && mismatched === 0 && Number(state?.failed_count || 0) === 0;
  return { migrationComplete, readyForSqlReads, kvsAssetCount, sqlAssetCount, countsMatch, sampled, missing, mismatched, examples, state };
}

export async function migrateAssetsBatch({ limit = 50, restart = false } = {}) {
  await runSqlSchemaMigration();
  const requestedLimit = Math.min(100, Math.max(10, Number(limit || 50)));
  const previous = (await getState()) || {};
  if (previous.status === 'complete' && restart !== true) return { complete: true, state: previous, batch: { processed: 0, migrated: 0, skipped: 0, failed: 0 } };
  const cursor = restart === true ? null : (previous.cursor_value || null);
  const page = await nextAssetPage(cursor, requestedLimit);
  let processed = 0, migrated = 0, skipped = 0, failed = 0, lastError = '';
  for (const entry of page.results || []) {
    processed += 1;
    try { const result = await upsertSqlAsset(entry.value || {}); if (result.changed) migrated += 1; else skipped += 1; }
    catch (error) { failed += 1; lastError = String(error?.message || error).slice(0, 1000); }
  }
  const complete = !page.nextCursor;
  const base = restart === true ? {} : previous;
  const next = { status: complete ? 'complete' : (failed ? 'running-with-errors' : 'running'), cursor_value: complete ? null : page.nextCursor, processed_count:Number(base.processed_count||0)+processed,migrated_count:Number(base.migrated_count||0)+migrated,skipped_count:Number(base.skipped_count||0)+skipped,failed_count:Number(base.failed_count||0)+failed,last_error:lastError||base.last_error||null,started_at:restart===true?nowSql():(base.started_at||nowSql()),completed_at:complete?nowSql():null };
  await saveState(next);
  return { complete, batch:{processed,migrated,skipped,failed}, state:await getState() };
}

resolver.define('prepareSqlStorage', async () => { await runSqlSchemaMigration(); const existing=await getState(); if(!existing)await saveState({status:'ready'}); return {ready:true,state:(await getState())||null}; });
resolver.define('migrateAssetsToSqlBatch', async ({payload}) => migrateAssetsBatch({limit:payload?.limit,restart:payload?.restart===true}));
resolver.define('getSqlMigrationStatus', async () => { await runSqlSchemaMigration(); return verifySqlCopy(); });
resolver.define('verifySqlMigration', async () => { await runSqlSchemaMigration(); return verifySqlCopy(); });

export async function runSqlDataMigrationScheduled() {
  const deadline=Date.now()+45000; let batches=0,processed=0,migrated=0,skipped=0,failed=0,complete=false;
  while(Date.now()<deadline&&!complete&&batches<20){const result=await migrateAssetsBatch({limit:50});batches+=1;processed+=result.batch?.processed||0;migrated+=result.batch?.migrated||0;skipped+=result.batch?.skipped||0;failed+=result.batch?.failed||0;complete=result.complete===true;if(!result.batch?.processed)break;}
  let verification=null;
  if(complete){try{verification=await verifySqlCopy();}catch(error){verification={readyForSqlReads:false,error:String(error?.message||error).slice(0,1000)};}}
  console.log('SQL asset migration scheduled pass',{batches,processed,migrated,skipped,failed,complete,readyForSqlReads:verification?.readyForSqlReads===true});
  return {batches,processed,migrated,skipped,failed,complete,verification};
}

export const handler = resolver.getDefinitions();