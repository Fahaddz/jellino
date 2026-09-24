import type { D1Database } from "@cloudflare/workers-types";

export async function readHiddenKeys(db: D1Database, profileId: string): Promise<Set<string>> {
  try {
    const rows = await db
      .prepare("SELECT item_key AS itemKey FROM hidden_items WHERE profile_id = ?1")
      .bind(profileId)
      .all<{ itemKey: string }>();
    return new Set((rows.results ?? []).map((row) => row.itemKey));
  } catch {
    return new Set();
  }
}

export async function isHiddenItem(db: D1Database, profileId: string, itemKey: string): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT 1 AS hit FROM hidden_items WHERE profile_id = ?1 AND item_key = ?2")
      .bind(profileId, itemKey)
      .first<{ hit: number }>();
    return row?.hit === 1;
  } catch {
    return false;
  }
}

export async function hideItem(db: D1Database, profileId: string, itemKey: string, now: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO hidden_items (profile_id, item_key, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(profile_id, item_key) DO UPDATE SET created_at = excluded.created_at",
    )
    .bind(profileId, itemKey, now)
    .run();
}

export async function unhideItem(db: D1Database, profileId: string, itemKey: string): Promise<void> {
  await db
    .prepare("DELETE FROM hidden_items WHERE profile_id = ?1 AND item_key = ?2")
    .bind(profileId, itemKey)
    .run();
}
