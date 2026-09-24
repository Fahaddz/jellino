const RATE_LIMIT_RETENTION_SECONDS = 86400;
const HEALTH_MAX_AGE_SECONDS = 2592000;
const APP_LOG_MAX_AGE_SECONDS = 604800;
const TOMBSTONE_TTL_SECONDS = 30 * 24 * 3600;

interface RunMeta {
  meta?: { changes?: number };
}

async function pruneTombstones(db: D1Database, now: number): Promise<number> {
  try {
    const res = await db
      .prepare("DELETE FROM sync_tombstones WHERE deleted_at < ?1")
      .bind(now - TOMBSTONE_TTL_SECONDS)
      .run();
    return res.meta?.changes ?? 0;
  } catch {
    return 0;
  }
}

export interface PruneCounts {
  rateLimits: number;
  health: number;
  quickConnect?: number;
  appLog?: number;
  tombstones?: number;
}

export async function pruneMaintenance(db: D1Database, now: number): Promise<PruneCounts> {
  const statements = [
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(now - RATE_LIMIT_RETENTION_SECONDS),
    db.prepare("DELETE FROM addon_health WHERE updated_at < ?1").bind(now - HEALTH_MAX_AGE_SECONDS),
    db.prepare("DELETE FROM quick_connect WHERE expires_at < ?1").bind(now),
    db.prepare("DELETE FROM app_log WHERE at < ?1").bind(now - APP_LOG_MAX_AGE_SECONDS),
  ];
  const outcomes = (await db.batch(statements)) as unknown as RunMeta[];
  const tombstones = await pruneTombstones(db, now);
  return {
    rateLimits: outcomes[0]?.meta?.changes ?? 0,
    health: outcomes[1]?.meta?.changes ?? 0,
    quickConnect: outcomes[2]?.meta?.changes ?? 0,
    appLog: outcomes[3]?.meta?.changes ?? 0,
    tombstones,
  };
}
