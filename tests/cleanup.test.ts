import { describe, expect, it } from "vitest";
import { registerFirstUser } from "../src/auth";
import { pruneMaintenance } from "../src/cleanup";
import { createFakeDb } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const NOW = 2000000000;


describe("automated cleanup", () => {
  it("prunes stale maintenance rows and keeps fresh ones", async () => {
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
    raw.rates.set("register:1.2.3.4", { window_start: NOW - 90000, count: 5 });
    raw.rates.set("register:5.6.7.8", { window_start: NOW, count: 1 });
    raw.health.set(`${admin.id}\nhttps://old.example`, { fails: 4, lastError: "down", updatedAt: NOW - 40 * 86400 });
    raw.health.set(`${admin.id}\nhttps://new.example`, { fails: 4, lastError: "down", updatedAt: NOW });

    const pruned = await pruneMaintenance(db, NOW);
    expect(pruned).toMatchObject({ rateLimits: 1, health: 1 });
    expect(raw.rates.has("register:5.6.7.8")).toBe(true);
    expect(raw.health.has(`${admin.id}\nhttps://new.example`)).toBe(true);
  });


});

