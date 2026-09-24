import { describe, expect, it } from "vitest";
import { COLUMN_UPGRADES, ensureSchema, LEGACY_DROPS, resetSchema, SCHEMA, SCHEMA_SQL, schemaReady, upgradeColumns } from "../src/schema";

type Db = import("@cloudflare/workers-types").D1Database;

const TABLES = [
  "profiles",
  "profile_addons",
  "watch_state",
  "profile_favorites",
  "rate_limits",
  "settings",
  "quick_connect",
  "addon_health",
  "app_log",
  "hidden_items",
  "sync_tombstones",
];

function stubDb(behavior: (count: number) => Promise<unknown>, existingColumns: string[] = COLUMN_UPGRADES.map((upgrade) => upgrade.column)) {
  const calls: number[] = [];
  const db = {
    prepare: (sql: string) => ({
      run: async () => {
        calls.push(1);
        return behavior(1);
      },
      all: async () => {
        if (sql.startsWith("PRAGMA table_info")) {
          return { results: existingColumns.map((name) => ({ name })) };
        }
        return { results: [] };
      },
    }),
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
  } as unknown as Db;
  return { db, calls };
}

function upgradeDb(existing: Set<string>) {
  const pragmas: string[] = [];
  const alters: string[] = [];
  const db = {
    prepare: (sql: string) => ({
      all: async () => {
        pragmas.push(sql);
        const table = /PRAGMA table_info\("?(\w+)"?\)/.exec(sql)?.[1] ?? "";
        const names = [...existing].filter((name) => name.startsWith(`${table}.`)).map((name) => name.slice(table.length + 1));
        return { results: names.map((name) => ({ name })) };
      },
      run: async () => {
        alters.push(sql);
        return { success: true };
      },
    }),
  } as unknown as Db;
  return { db, pragmas, alters };
}

describe("first-request schema", () => {
  it("covers every table", () => {
    for (const table of TABLES) {
      expect(SCHEMA).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("runs once per isolate no matter how many requests", async () => {
    resetSchema();
    const { db, calls } = stubDb(async () => undefined);
    await Promise.all([ensureSchema(db), ensureSchema(db), ensureSchema(db)]);
    expect(calls).toHaveLength(SCHEMA_SQL.length + LEGACY_DROPS.length);
    expect(schemaReady()).toBe(true);
    resetSchema();
  });

  it("retries on the next request after a failure", async () => {
    resetSchema();
    let attempts = 0;
    const { db, calls } = stubDb(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("down");
      }
      return undefined;
    });
    await expect(ensureSchema(db)).rejects.toThrow("down");
    expect(schemaReady()).toBe(false);
    expect(calls).toHaveLength(1);
    await ensureSchema(db);
    expect(schemaReady()).toBe(true);
    resetSchema();
  });

  it("adds every column an older database is missing", async () => {
    const existing = new Set(["app_log.id", "profiles.id", "profiles.name", "watch_state.item_key", "addon_health.addon_url"]);
    const { db, alters } = upgradeDb(existing);
    await upgradeColumns(db);
    const expected = COLUMN_UPGRADES.filter((upgrade) => !existing.has(`${upgrade.table}.${upgrade.column}`));
    expect(alters).toHaveLength(expected.length);
    for (const upgrade of expected) {
      expect(alters).toContain(`ALTER TABLE ${upgrade.table} ADD COLUMN ${upgrade.column} ${upgrade.definition}`);
    }
  });

  it("touches nothing when every column already exists", async () => {
    const existing = new Set(COLUMN_UPGRADES.map((upgrade) => `${upgrade.table}.${upgrade.column}`));
    const { db, alters } = upgradeDb(existing);
    await upgradeColumns(db);
    expect(alters).toHaveLength(0);
  });
});
