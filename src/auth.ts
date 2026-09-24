import type { D1Database } from "@cloudflare/workers-types";
import { toHex } from "./hash";

const encoder = new TextEncoder();
const PBKDF2_ITERATIONS = 100000;
const REGISTER_WINDOW_SECONDS = 600;
const REGISTER_MAX_ATTEMPTS = 5;

export function newSalt(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

export async function verifyPassword(
  password: string,
  salt: string,
  expectedHex: string,
): Promise<boolean> {
  const actualHex = await hashPassword(password, salt);
  const a = encoder.encode(actualHex);
  const b = encoder.encode(expectedHex);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

export async function burnPasswordCycle(password: string): Promise<void> {
  await hashPassword(password, "00000000000000000000".slice(0, 32));
}

export async function registerAllowed(db: D1Database, ip: string, now: number): Promise<boolean> {
  const key = `register:${ip}`;
  const row = await db
    .prepare("SELECT window_start, count FROM rate_limits WHERE key = ?")
    .bind(key)
    .first<{ window_start: number; count: number }>();
  if (!row || now - row.window_start >= REGISTER_WINDOW_SECONDS) {
    await db
      .prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1")
      .bind(key, now)
      .run();
    return true;
  }
  if (row.count >= REGISTER_MAX_ATTEMPTS) return false;
  await db
    .prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?")
    .bind(key)
    .run();
  return true;
}

export interface RegisterResult {
  ok: boolean;
  status: 201 | 400 | 403;
  body: Record<string, unknown>;
}

export async function registerFirstUser(
  db: D1Database,
  name: string,
  password: string,
  now: number,
): Promise<RegisterResult> {
  const cleanName = name.trim();
  if (cleanName.length < 1 || cleanName.length > 64) {
    return { ok: false, status: 400, body: { error: "invalid name" } };
  }
  if (password.length < 8 || password.length > 256) {
    return { ok: false, status: 400, body: { error: "invalid password" } };
  }
  const existing = await db
    .prepare("SELECT COUNT(*) AS total FROM profiles")
    .first<{ total: number }>();
  if ((existing?.total ?? 0) > 0) {
    return { ok: false, status: 403, body: { error: "registration closed" } };
  }
  const salt = newSalt();
  const passwordHash = await hashPassword(password, salt);
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO profiles (id, name, password_hash, salt, is_admin, addon_mode, created_at) VALUES (?, ?, ?, ?, 1, 'custom', ?)",
    )
    .bind(id, cleanName, passwordHash, salt, now)
    .run();
  return { ok: true, status: 201, body: { id, name: cleanName, admin: true } };
}
