import { describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "../src/schema";

/// <reference types="node" />
import { readFileSync } from "node:fs";
const MIGRATION = readFileSync("./migrations/0001_init.sql", "utf8");

function squeezed(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();
}

function splitStatements(sql: string): string[] {
  return normalizeStatements(sql);
}

function normalizeStatements(raw: string): string[] {
  const cleaned = raw.replace(/;/g, ";\n");
  const out: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of cleaned) {
    if (char === ";" && depth === 0) {
      const trimmed = current.replace(/\s+/g, " ").trim();
      if (trimmed) out.push(trimmed);
      current = "";
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    current += char;
  }
  const tail = current.replace(/\s+/g, " ").trim();
  if (tail.replace(/\s+/g, " ")) out.push(tail);
  return out;
}

describe("migration and schema drift guard", () => {
  it("keeps migrations/0001_init.sql and src/schema.ts in sync", () => {
    const source = normalizeStatements(MIGRATION).map(squeezed).sort();
    const generated = SCHEMA_SQL.map(squeezed).sort();
    expect(source).toEqual(generated);
  });

  it("includes the token_epoch revocation column", () => {
    expect(SCHEMA_SQL.some((statement) => statement.includes("token_epoch"))).toBe(true);
    expect(MIGRATION.includes("token_epoch")).toBe(true);
  });

  it("does not resurrect removed pin columns", () => {
    expect(SCHEMA_SQL.some((statement) => statement.includes("pin_enabled"))).toBe(false);
    expect(MIGRATION.includes("pin_enabled")).toBe(false);
  });
});
