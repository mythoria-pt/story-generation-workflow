import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

const MESSAGES_DIR = path.resolve(process.cwd(), 'src/messages');
const BASE_LOCALE = 'en-US';

interface LocaleData {
  locale: string;
  files: Map<string, Set<string>>;
}

function collectLeafKeys(value: JsonValue, prefix: string, result: Set<string>) {
  if (value === null) {
    result.add(prefix);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const nextPrefix = prefix ? `${prefix}[${index}]` : `[${index}]`;
      collectLeafKeys(item as JsonValue, nextPrefix, result);
    });
    return;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as JsonObject);
    if (!entries.length && prefix) {
      result.add(prefix);
      return;
    }

    for (const [key, child] of entries) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      collectLeafKeys(child, nextPrefix, result);
    }
    return;
  }

  if (prefix) {
    result.add(prefix);
  }
}

async function loadLocale(locale: string): Promise<LocaleData> {
  const localeDir = path.join(MESSAGES_DIR, locale);
  const files = new Map<string, Set<string>>();
  let entries: Dirent[];

  try {
    entries = await fs.readdir(localeDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Failed to read locale directory "${locale}": ${(error as Error).message}`);
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const fullPath = path.join(localeDir, entry.name);
    const raw = await fs.readFile(fullPath, 'utf8');
    let parsed: JsonObject;

    try {
      parsed = JSON.parse(raw) as JsonObject;
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${path.relative(process.cwd(), fullPath)}: ${(error as Error).message}`,
      );
    }

    const keys = new Set<string>();
    collectLeafKeys(parsed, '', keys);
    files.set(entry.name, keys);
  }

  return { locale, files };
}

async function listLocales(): Promise<string[]> {
  const entries = await fs.readdir(MESSAGES_DIR, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function logMissing(locale: string, fileName: string, missing: string[]) {
  if (!missing.length) {
    return;
  }

  console.error(`\nMissing translations for ${locale}/${fileName}:`);
  missing.sort().forEach((key) => console.error(`  - ${key}`));
}

function logExtra(locale: string, fileName: string, extra: string[]) {
  if (!extra.length) {
    return;
  }

  console.warn(`\nExtra keys in ${locale}/${fileName}:`);
  extra.sort().forEach((key) => console.warn(`  - ${key}`));
}

function resolveTargetLocales(allLocales: string[], requested: string[]): string[] {
  const normalized = requested
    .map((locale) => locale.trim())
    .filter((locale) => locale.length > 0 && locale !== BASE_LOCALE);

  if (normalized.length === 0) {
    return allLocales.filter((locale) => locale !== BASE_LOCALE);
  }

  const missing = normalized.filter((locale) => !allLocales.includes(locale));
  if (missing.length) {
    throw new Error(`Unknown locale(s): ${missing.join(', ')}`);
  }

  return normalized;
}

async function runKeysCheck(requestedLocales: string[]) {
  const locales = await listLocales();
  if (!locales.includes(BASE_LOCALE)) {
    throw new Error(`Base locale "${BASE_LOCALE}" not found in ${MESSAGES_DIR}`);
  }

  const base = await loadLocale(BASE_LOCALE);
  const targets = resolveTargetLocales(locales, requestedLocales);
  const others = await Promise.all(targets.map(loadLocale));

  let hasErrors = false;

  for (const locale of others) {
    for (const [fileName, baseKeys] of base.files.entries()) {
      const targetKeys = locale.files.get(fileName);
      if (!targetKeys) {
        console.error(`\nLocale ${locale.locale} is missing file ${fileName}`);
        hasErrors = true;
        continue;
      }

      const missingKeys = [...baseKeys].filter((key) => !targetKeys.has(key));
      if (missingKeys.length) {
        logMissing(locale.locale, fileName, missingKeys);
        hasErrors = true;
      }
    }
  }

  if (hasErrors) {
    console.error('\ni18n:keys detected missing translations.');
    process.exitCode = 1;
    return;
  }

  console.log('All locales contain required keys from the base locale.');
}

async function runParityCheck(requestedLocales: string[]) {
  const locales = await listLocales();
  if (!locales.includes(BASE_LOCALE)) {
    throw new Error(`Base locale "${BASE_LOCALE}" not found in ${MESSAGES_DIR}`);
  }

  const base = await loadLocale(BASE_LOCALE);
  const baseFiles = new Set(base.files.keys());
  const targets = resolveTargetLocales(locales, requestedLocales);
  const others = await Promise.all(targets.map(loadLocale));

  let hasErrors = false;

  for (const locale of others) {
    const localeFiles = new Set(locale.files.keys());
    const missingFiles = [...baseFiles].filter((file) => !localeFiles.has(file));
    const extraFiles = [...localeFiles].filter((file) => !baseFiles.has(file));

    if (missingFiles.length) {
      console.error(`\nLocale ${locale.locale} is missing files:`);
      missingFiles.sort().forEach((file) => console.error(`  - ${file}`));
      hasErrors = true;
    }

    if (extraFiles.length) {
      logExtra(locale.locale, '(file set)', extraFiles);
    }
  }

  if (hasErrors) {
    console.error('\ni18n:parity detected missing files.');
    process.exitCode = 1;
    return;
  }

  console.log('All locales include the same translation files as the base locale.');
}

async function main() {
  const mode = process.argv[2];

  if (mode !== 'keys' && mode !== 'parity') {
    console.error('Usage: tsx scripts/check-i18n.ts <keys|parity>');
    process.exitCode = 1;
    return;
  }

  const requestedLocales = process.argv.slice(3);

  if (mode === 'keys') {
    await runKeysCheck(requestedLocales);
  } else {
    await runParityCheck(requestedLocales);
  }
}

void main();
