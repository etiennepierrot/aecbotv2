/**
 * Chargé avant les scripts `:prod` (`tsx --import ./scripts/prod-env.ts …`) : les valeurs de
 * .env.production remplacent celles déjà définies dans le terminal.
 *
 * `--env-file` ne le fait pas : un DATABASE_URL (ou une clé) resté dans le shell gagnait, et le
 * script lisait ou écrivait la base locale sans prévenir.
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const prod = parseEnv(readFileSync(".env.production", "utf8"));
const remplacees = Object.keys(prod).filter((k) => process.env[k] !== undefined && process.env[k] !== prod[k]);
Object.assign(process.env, prod);
if (remplacees.length) {
  console.error(`.env.production remplace des variables du terminal : ${remplacees.join(", ")}`);
}
