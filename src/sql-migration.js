import { kvs, WhereConditions } from '@forge/kvs';
import sql from '@forge/sql';
import { runSqlSchemaMigration } from './sql-schema.js';
import { upsertSqlAsset, upsertCrewMember } from './sql-storage.js';

const ASSET_PREFIX = 'asset:';
const CREW_PREFIX = 'internal-crew:';
const ASSET_MIGRATION_KEY = 'internal-kvs-assets-to-sql-v1';
const CREW_MIGRATION_KEY = 'internal-kvs-crew-to-sql-v1';
const nowSql = () => new Date().toISOString().slice(0, 23).replace('T', ' ');

async function getState(key) {
  const result = await sql.prepare('SELECT * FROM DataMigrationState WHERE migration_key = ? LIMIT 1').bindParams(key).execute();
  return result.rows?.[0] || null;
}

async function saveState(key, state = {}) {
  const timestamp = nowSql();
  await sql.prepare(`INSERT INTO DataMigrationState (
    migration_key,status,cursor_value,processed_count,migrated_count,skipped_count,failed_count,last_error,started_at,updated_at,completed_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON DUPLICATE KEY UPDATE status=VALUES(status),cursor_value=VALUES(cursor_value),processed_count=VALUES(processed_count),migrated_count=VALUES(migrated_count),skipped_count=VALUES(skipped_count),failed_count=VALUES(failed_count),last_error=VALUES(last_error),updated_at=VALUES(updated_at),completed_at=VALUES(completed_at)`)
    .bindParams(key,state.status||'running',state.cursor_value||null,Number(state.processed_count||0),Number(state.migrated_count||0),Number(state.skipped_count||0),Number(state.failed_count||0),state.last_error||null,state.started_at||timestamp,timestamp,state.completed_at||null).execute();
}

async function nextPage(prefix, cursor, limit) {
  let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(Math.min(100, Math.max(10, Number(limit || 50))));
  if (cursor) query = query.cursor(cursor);
  return query.getMany();
}

async function migratePrefix({ key, prefix, limit = 50, writer }) {
  await runSqlSchemaMigration();
  const previous = (await getState(key)) || {};
  if (previous.status === 'complete') return { complete: true, batch: { processed: 0, migrated: 0, skipped: 0, failed: 0 }, state: previous };
  const page = await nextPage(prefix, previous.cursor_value || null, limit);
  let processed=0,migrated=0,skipped=0,failed=0,lastError='';
  for (const entry of page.results || []) {
    processed += 1;
    try {
      const result = await writer(entry.value || {});
      if (result?.changed === false) skipped += 1; else migrated += 1;
    } catch (error) {
      failed += 1;
      lastError = String(error?.message || error).slice(0,1000);
    }
  }
  const complete = !page.nextCursor;
  const next = {
    status: complete ? 'complete' : (failed ? 'running-with-errors' : 'running'),
    cursor_value: complete ? null : page.nextCursor,
    processed_count:Number(previous.processed_count||0)+processed,
    migrated_count:Number(previous.migrated_count||0)+migrated,
    skipped_count:Number(previous.skipped_count||0)+skipped,
    failed_count:Number(previous.failed_count||0)+failed,
    last_error:lastError||previous.last_error||null,
    started_at:previous.started_at||nowSql(),
    completed_at:complete?nowSql():null
  };
  await saveState(key,next);
  return { complete, batch:{processed,migrated,skipped,failed}, state:await getState(key) };
}

export async function runInternalSqlDataMigrationScheduled() {
  const deadline = Date.now()+45000;
  const summary={assetBatches:0,crewBatches:0,assetsProcessed:0,crewProcessed:0,failed:0,complete:false};
  while(Date.now()<deadline && summary.crewBatches<10){
    const result=await migratePrefix({key:CREW_MIGRATION_KEY,prefix:CREW_PREFIX,limit:50,writer:async crew=>{await upsertCrewMember(crew);return{changed:true};}});
    summary.crewBatches+=1;summary.crewProcessed+=result.batch?.processed||0;summary.failed+=result.batch?.failed||0;
    if(result.complete||!result.batch?.processed)break;
  }
  while(Date.now()<deadline && summary.assetBatches<10){
    const result=await migratePrefix({key:ASSET_MIGRATION_KEY,prefix:ASSET_PREFIX,limit:50,writer:upsertSqlAsset});
    summary.assetBatches+=1;summary.assetsProcessed+=result.batch?.processed||0;summary.failed+=result.batch?.failed||0;
    if(result.complete||!result.batch?.processed)break;
  }
  const [crewState,assetState,counts] = await Promise.all([
    getState(CREW_MIGRATION_KEY),
    getState(ASSET_MIGRATION_KEY),
    sql.prepare('SELECT (SELECT COUNT(*) FROM CrewMembers) AS crew_count, (SELECT COUNT(*) FROM Assets) AS asset_count').execute()
  ]);
  summary.complete=crewState?.status==='complete'&&assetState?.status==='complete';
  summary.crewCount=Number(counts.rows?.[0]?.crew_count||0);
  summary.assetCount=Number(counts.rows?.[0]?.asset_count||0);
  console.log('Internal SQL migration scheduled pass',summary);
  return summary;
}
