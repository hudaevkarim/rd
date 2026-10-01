/**
 * Проверка целостности ZIP-архива: сверяет каждую запись с исходным файлом
 * по SHA-256 и отдельно контролирует, что в именах записей только прямые
 * слэши (обратные ломают распаковку на Linux и macOS).
 *
 * Запуск: node scripts/verify-archive.mjs <архив> <корень проекта>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { unzipSync } from 'fflate';

const [, , zipPath, rootArg, prefixArg] = process.argv;
if (!zipPath || !rootArg) {
  console.error('использование: node scripts/verify-archive.mjs <архив> <корень> [префикс]');
  process.exit(2);
}
const root = rootArg.replace(/[\\/]+$/, '');
/** Имя корневой папки внутри архива: записи начинаются с него, а в проекте — нет. */
const prefix = prefixArg === undefined || prefixArg === '' ? '' : prefixArg.replace(/[\\/]+$/, '') + '/';

const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git', '.vite']);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const sources = walk(root).map((full) => ({
  // Имена в архиве всегда с прямым слэшем, независимо от системы.
  entry: prefix + relative(root, full).split(sep).join('/'),
  full,
}));

const bytes = new Uint8Array(readFileSync(zipPath));
const entries = unzipSync(bytes, { filter: (f) => f.name !== '__MACOSX' && !f.name.startsWith('__MACOSX/') });

const names = Object.keys(entries);
const problems = [];

for (const name of names) {
  if (name.includes('\\')) problems.push(`обратный слэш в записи: ${name}`);
  if (name.endsWith('/')) problems.push(`запись-каталог вместо файла: ${name}`);
}

const byName = new Map(sources.map((s) => [s.entry, s]));
for (const name of names) {
  if (!byName.has(name)) problems.push(`лишнее в архиве: ${name}`);
}
for (const s of sources) {
  if (!(s.entry in entries)) problems.push(`потеряно при упаковке: ${s.entry}`);
}

let compared = 0;
for (const s of sources) {
  const packed = entries[s.entry];
  if (packed === undefined) continue;
  const a = createHash('sha256').update(readFileSync(s.full)).digest('hex');
  const b = createHash('sha256').update(packed).digest('hex');
  if (a !== b) problems.push(`хеш не совпал: ${s.entry}`);
  compared++;
}

const totalBytes = sources.reduce((sum, s) => sum + readFileSync(s.full).length, 0);
const packedBytes = names.reduce((sum, n) => sum + (entries[n]?.length ?? 0), 0);

console.log(`файлов в архиве:   ${names.length}`);
console.log(`файлов в проекте:  ${sources.length}`);
console.log(`сверено по хешу:   ${compared}`);
console.log(`размер исходников:  ${(totalBytes / 1024).toFixed(1)} КБ`);
console.log(`раз��р в архиве:    ${(packedBytes / 1024).toFixed(1)} КБ`);
console.log(problems.length === 0 ? 'ПРОБЛЕМ НЕТ' : `ПРОБЛЕМ: ${problems.length}`);
for (const p of problems.slice(0, 20)) console.log('  - ' + p);
process.exit(problems.length === 0 ? 0 : 1);
