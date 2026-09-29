import type { Context } from "hono";
import type { Env } from "./db";

export function queryIgnoreCase(c: Context<{ Bindings: Env }>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(c.req.query())) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export function boolQuery(c: Context<{ Bindings: Env }>, name: string): boolean | null {
  const raw = queryIgnoreCase(c, name);
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.length === 0) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric === 1) return true;
  if (numeric === 0) return false;
  return null;
}

export function csvSet(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0),
  );
}

export function imageWidth(c: Context<{ Bindings: Env }>): number | null {
  for (const [key, value] of Object.entries(c.req.query())) {
    const lower = key.toLowerCase();
    if (lower === "maxwidth" || lower === "width" || lower === "fillwidth") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return null;
}

export function pageParams(
  c: Context<{ Bindings: Env }>,
  fallback = 100,
  options: { positiveLimit?: boolean } = {},
): { limit: number; start: number } {
  const rawLimit = Number(queryIgnoreCase(c, "limit") ?? fallback);
  const rawStart = Number(queryIgnoreCase(c, "startIndex") ?? 0);
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : fallback;
  const start = Number.isFinite(rawStart) ? Math.max(0, Math.floor(rawStart)) : 0;
  if (options.positiveLimit && limit <= 0) return { limit: fallback, start };
  return { limit: Math.max(0, limit), start };
}
