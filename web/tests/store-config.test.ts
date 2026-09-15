/**
 * Only a real Postgres URL may select the Postgres store. The repo-root .env sets
 * DATABASE_URL to a Python sqlite URL, which used to be mistaken for Postgres.
 */
import { describe, it, expect } from "vitest";
import { isPostgresUrl, isStoreNotConfigured, StoreNotConfiguredError } from "@/lib/invoice/store/config";

describe("postgres URL detection", () => {
  it.each([
    "postgres://user:pw@ep-cool-123.eu-central-1.aws.neon.tech/neondb?sslmode=require",
    "postgresql://user:pw@localhost:5432/sautice",
  ])("accepts %s", (url) => {
    expect(isPostgresUrl(url)).toBe(true);
  });

  it.each([
    "sqlite+aiosqlite:///./sautice.db",
    "",
    "postgres://",
    "not a url",
    "mysql://user@host/db",
  ])("rejects %j", (url) => {
    expect(isPostgresUrl(url)).toBe(false);
  });
});

describe("not-configured error", () => {
  it("is recognised by its code", () => {
    expect(isStoreNotConfigured(new StoreNotConfiguredError())).toBe(true);
    expect(isStoreNotConfigured(new Error("boom"))).toBe(false);
    expect(isStoreNotConfigured(null)).toBe(false);
  });
});
