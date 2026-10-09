import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

/**
 * Minimal .env.local loader for CLI scripts (migrate/seed/tests) where Next.js
 * isn't loading env for us. No-ops for keys already set in the environment.
 */
export function loadEnv(file = ".env.local"): void {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    // `\$` is how a literal dollar sign is written for Next.js, whose loader
    // expands `$NAME` references — keep both loaders reading the same value.
    process.env[key] = raw.replace(/^["']|["']$/g, "").replace(/\\\$/g, "$");
  }
}
