import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Migration } from "./migrate.js";

/**
 * Discover and load migration SQL files from the `migrations/` directory that
 * sits next to this file. Returns an immutable list of `{ id, up }` records
 * sorted ascending by filename so `001_*.sql` is always applied before
 * `002_*.sql`.
 *
 * `id` is the filename with the `.sql` suffix stripped. `up` is the raw SQL
 * contents of the file.
 *
 * Resolution is anchored to `import.meta.url` so this works whether the daemon
 * runs from `src/` (via tsx/dev) or eventually `dist/`. Note that `tsc` does
 * not copy `.sql` files into `dist/`; a build-step copy will be wired up when
 * the production launchd plist lands (Phase A Task 39 carry-forward).
 */
export function loadMigrations(): readonly Migration[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = resolve(here, "migrations");

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  return files.map((name) => {
    const fullPath = resolve(migrationsDir, name);
    const up = readFileSync(fullPath, "utf8");
    const id = name.slice(0, -".sql".length);
    return { id, up };
  });
}
