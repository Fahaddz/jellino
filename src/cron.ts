import { pruneMaintenance, type PruneCounts } from "./cleanup";
import { fetchManifests } from "./library";
import { ensureSchema } from "./schema";
import { syncFromNuvio, syncHomeLibraries } from "./nuvio-home";

const CRON_MAX_MANIFESTS = 40;
const MAINTENANCE_INTERVAL_SECONDS = 3600;

const EMPTY_PRUNE: PruneCounts = {
  rateLimits: 0,
  health: 0,
  quickConnect: 0,
  appLog: 0,
  tombstones: 0,
};

interface MaintenanceResult {
  pruned: PruneCounts;
}

const maintenanceCache = new WeakMap<D1Database, number>();

export async function maintenanceDue(db: D1Database, now: number): Promise<boolean> {
  const cached = maintenanceCache.get(db);
  if (cached !== undefined && now - cached < MAINTENANCE_INTERVAL_SECONDS) {
    return false;
  }
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?1")
    .bind("last_maintenance")
    .first<{ value: string }>();
  const last = row ? Number(row.value) : NaN;
  const due = !Number.isFinite(last) || now - last >= MAINTENANCE_INTERVAL_SECONDS;
  if (!due && Number.isFinite(last)) {
    maintenanceCache.set(db, last);
  }
  return due;
}

async function runMaintenance(
  db: D1Database,
  fetchImpl: typeof fetch,
  now: number,
): Promise<MaintenanceResult> {
  await ensureSchema(db);
  maintenanceCache.set(db, now);
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind("last_maintenance", String(now))
    .run();
  const pruned = await pruneMaintenance(db, now);
  return { pruned };
}

export async function maybeMaintenance(
  db: D1Database,
  fetchImpl: typeof fetch,
  now: number,
): Promise<boolean> {
  if (!(await maintenanceDue(db, now))) return false;
  await runMaintenance(db, fetchImpl, now);
  return true;
}

export async function runScheduled(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  now: number,
): Promise<{ manifests: number; pruned: PruneCounts }> {
  await ensureSchema(db);
  try {
    await syncFromNuvio(db, fetchImpl);
    try {
      await syncHomeLibraries(db, fetchImpl, cache);
    } catch {
      void 0;
    }
  } catch {
  }
  const rows = await db.prepare("SELECT DISTINCT url FROM profile_addons").all<{ url: string }>();
  const urls = [...new Set((rows.results ?? []).map((row) => row.url))].slice(0, CRON_MAX_MANIFESTS);
  await fetchManifests(cache, fetchImpl, urls);
  const maintained = (await maintenanceDue(db, now))
    ? await runMaintenance(db, fetchImpl, now)
    : { pruned: EMPTY_PRUNE };
  return { manifests: urls.length, ...maintained };
}
