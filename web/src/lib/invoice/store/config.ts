/**
 * Which store backend this process should use. Kept apart from pg.ts so reading
 * the configuration never loads the Postgres driver.
 *
 * Only a real postgres:// or postgresql:// URL selects Postgres. The repo-root
 * .env.example sets DATABASE_URL to a Python `sqlite+aiosqlite://` URL, which
 * `pnpm dev` loads; treating that as Postgres made the store try to connect to a
 * database that does not exist.
 */
export function isPostgresUrl(value: string | undefined | null): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return (u.protocol === "postgres:" || u.protocol === "postgresql:") && u.hostname.length > 0;
  } catch {
    return false;
  }
}

export const PG_URL =
  [process.env.DATABASE_URL, process.env.POSTGRES_URL, process.env.POSTGRES_PRISMA_URL].find(isPostgresUrl) ?? "";

export type StoreBackend = "postgres" | "sqlite" | "missing";

/** Production hosts need Postgres; SQLite is only a local, zero-setup fallback. */
export function storeBackend(): StoreBackend {
  if (PG_URL) return "postgres";
  return process.env.NODE_ENV === "production" ? "missing" : "sqlite";
}

/** Thrown when a production deployment has no usable database URL. */
export class StoreNotConfiguredError extends Error {
  readonly code = "DB_NOT_CONFIGURED";
  constructor() {
    super("No database configured. Set DATABASE_URL / POSTGRES_URL to a postgres:// URL (e.g. Neon). See docs/deploy-vercel.md.");
    this.name = "StoreNotConfiguredError";
  }
}

export function isStoreNotConfigured(e: unknown): boolean {
  return e instanceof StoreNotConfiguredError || (e as { code?: string } | null)?.code === "DB_NOT_CONFIGURED";
}
