/**
 * Compare environment variable names across:
 * - Static scan of process.env usage in source
 * - env.manifest.ts
 * - Zod schema (src/config/environment.ts)
 * - .env.local (active keys only)
 * - Optional cloudbuild.yaml (best-effort: --update-env-vars, --set-secrets, YAML env keys)
 *
 * Usage:
 *   npx tsx scripts/check-env-parity.ts [--strict-local] [--strict-cloudbuild] [--cloudbuild=path]
 * Env:
 *   CLOUDBUILD_PATH — default ./cloudbuild.yaml if that file exists
 */
import fs from 'node:fs';
import path from 'node:path';

import { envManifest } from '../env.manifest';
import { zodEnvironmentVariableNames } from '../src/config/environment';

const IGNORE_CODE_ENV_NAMES = new Set([
  'ProgramFiles',
  'ProgramFiles(x86)',
  // This script reads CLOUDBUILD_PATH from the environment; exclude from parity drift.
  'CLOUDBUILD_PATH',
]);

const SCAN_TOP_DIRS = ['src', 'scripts'];
const ROOT_SCAN_FILES = ['drizzle.config.ts', 'drizzle.workflows.config.ts'];

function walkTsFiles(dir: string, acc: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'coverage') continue;
      walkTsFiles(p, acc);
    } else if (/\.(ts|tsx|mts|cts)$/.test(ent.name) && !ent.name.endsWith('.d.ts')) {
      acc.push(p);
    }
  }
}

function collectProcessEnvNames(source: string): Set<string> {
  const out = new Set<string>();
  const dot = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = dot.exec(source)) !== null) {
    out.add(m[1]);
  }
  const bracket = /process\.env\[\s*['"]([^'"]+)['"]\s*\]/g;
  while ((m = bracket.exec(source)) !== null) {
    out.add(m[1]);
  }
  return out;
}

function parseDotEnvKeys(filePath: string): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(filePath)) return out;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key) out.add(key);
  }
  return out;
}

function extractCloudbuildEnvHints(content: string): Set<string> {
  const s = new Set<string>();

  const addPairList = (blob: string) => {
    for (const segment of blob.split(',')) {
      const piece = segment.trim();
      const eq = piece.indexOf('=');
      if (eq > 0) {
        const k = piece.slice(0, eq).trim();
        if (/^[A-Z][A-Z0-9_]*$/.test(k)) s.add(k);
      }
    }
  };

  for (const m of content.matchAll(/--update-env-vars(?:=|\s+)([^\n\r\\]+)/g)) {
    addPairList(m[1]);
  }
  for (const m of content.matchAll(/--set-secrets(?:=|\s+)([^\n\r\\]+)/g)) {
    addPairList(m[1]);
  }
  for (const m of content.matchAll(/\bsecretEnv\s*:\s*\[([^\]]+)\]/g)) {
    const inner = m[1];
    for (const q of inner.matchAll(/['"]([A-Z][A-Z0-9_]*)['"]/g)) {
      s.add(q[1]);
    }
  }
  // Heuristic: YAML keys that look like env names (ALL_CAPS_WITH_UNDERSCORES only)
  for (const line of content.split(/\n/)) {
    const t = line.trimStart();
    const mm = /^([A-Z][A-Z0-9_]*[A-Z0-9])\s*:\s/.exec(t);
    if (mm && /_/.test(mm[1])) s.add(mm[1]);
  }

  return s;
}

function sorted<T>(iter: Iterable<T>): T[] {
  return [...iter].sort() as T[];
}

function main() {
  const args = process.argv.slice(2);
  const strictLocal = args.includes('--strict-local');
  const strictCloudbuild = args.includes('--strict-cloudbuild');
  let cloudbuildPath = process.env.CLOUDBUILD_PATH ?? '';
  const cbArg = args.find((a) => a.startsWith('--cloudbuild='));
  if (cbArg) cloudbuildPath = cbArg.slice('--cloudbuild='.length).trim();
  if (!cloudbuildPath) {
    const def = path.join(process.cwd(), 'cloudbuild.yaml');
    if (fs.existsSync(def)) cloudbuildPath = def;
  }

  const codeNames = new Set<string>();
  const files: string[] = [];
  for (const d of SCAN_TOP_DIRS) walkTsFiles(path.join(process.cwd(), d), files);
  for (const f of ROOT_SCAN_FILES) {
    const p = path.join(process.cwd(), f);
    if (fs.existsSync(p)) files.push(p);
  }
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const n of collectProcessEnvNames(src)) {
      if (!IGNORE_CODE_ENV_NAMES.has(n)) codeNames.add(n);
    }
  }

  const manifestNames = new Set(envManifest.map((v) => v.name));
  const zodNames = new Set(zodEnvironmentVariableNames);
  const localPath = path.join(process.cwd(), '.env.local');
  const localNames = parseDotEnvKeys(localPath);

  let cloudNames = new Set<string>();
  let cloudSource = '';
  if (cloudbuildPath && fs.existsSync(cloudbuildPath)) {
    cloudSource = cloudbuildPath;
    cloudNames = extractCloudbuildEnvHints(fs.readFileSync(cloudbuildPath, 'utf8'));
  }

  const inCodeNotManifest = sorted([...codeNames].filter((n) => !manifestNames.has(n)));
  const inManifestNotZod = sorted([...manifestNames].filter((n) => !zodNames.has(n)));
  const inZodNotManifest = sorted([...zodNames].filter((n) => !manifestNames.has(n)));
  const inCodeNotZod = sorted([...codeNames].filter((n) => !zodNames.has(n)));

  const localOrphans = sorted([...localNames].filter((n) => !manifestNames.has(n)));
  const cloudOrphans =
    cloudNames.size > 0 ? sorted([...cloudNames].filter((n) => !manifestNames.has(n))) : [];

  const requiredProd = envManifest
    .filter((v) => v.required && v.scopes.includes('prod'))
    .map((v) => v.name);

  const missingFromCloudbuild =
    cloudNames.size > 0
      ? requiredProd.filter((n) => !cloudNames.has(n))
      : [];

  console.log('=== Environment parity report ===\n');
  console.log(`Scanned ${files.length} source files for process.env usage.`);
  console.log(`Manifest entries: ${manifestNames.size}`);
  console.log(`Zod keys: ${zodNames.size}`);
  console.log(`.env.local keys: ${localNames.size} (${fs.existsSync(localPath) ? localPath : 'file missing'})`);
  console.log(
    cloudSource
      ? `Cloud Build file: ${cloudSource} (${cloudNames.size} inferred names)`
      : 'Cloud Build file: not found (set CLOUDBUILD_PATH or add ./cloudbuild.yaml)',
  );

  const printList = (title: string, arr: string[]) => {
    console.log(`\n${title}${arr.length ? ` (${arr.length})` : ''}`);
    if (arr.length) arr.forEach((x) => console.log(`  - ${x}`));
    else console.log('  (none)');
  };

  printList('Used in code but not in env.manifest.ts', inCodeNotManifest);
  printList('In env.manifest.ts but not in Zod schema', inManifestNotZod);
  printList('In Zod schema but not in env.manifest.ts', inZodNotManifest);
  printList('Used in code but not in Zod schema', inCodeNotZod);
  printList('.env.local keys not in manifest (optional noise: tooling-only)', localOrphans);
  if (cloudNames.size > 0) {
    printList('Names inferred from Cloud Build but not in manifest', cloudOrphans);
  }
  if (cloudNames.size > 0 && missingFromCloudbuild.length > 0) {
    printList(
      'Required (prod) manifest vars not found by heuristic in Cloud Build file (check substitutions / secret refs)',
      missingFromCloudbuild,
    );
  }

  let exitCode = 0;

  if (inCodeNotManifest.length || inCodeNotZod.length || inManifestNotZod.length || inZodNotManifest.length) {
    console.log('\n❌ Manifest / Zod / code mismatch. Resolve drift before shipping.');
    exitCode = 1;
  }

  if (strictLocal && localOrphans.length) {
    console.log('\n❌ --strict-local: .env.local contains keys not listed in env.manifest.ts');
    exitCode = 1;
  }

  if (strictCloudbuild && cloudNames.size > 0 && missingFromCloudbuild.length > 0) {
    console.log('\n❌ --strict-cloudbuild: required prod vars missing from Cloud Build heuristic match.');
    exitCode = 1;
  } else if (cloudNames.size > 0 && missingFromCloudbuild.length > 0) {
    console.log(
      '\n⚠️  Some required prod manifest variables were not matched in cloudbuild.yaml heuristics. Pass --strict-cloudbuild to fail on this, or confirm substitutions map to real env names.',
    );
  }

  if (exitCode === 0) {
    console.log('\n✅ Parity check passed (see notes above for any optional warnings).');
  }

  process.exit(exitCode);
}

main();
