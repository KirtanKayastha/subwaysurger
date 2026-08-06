/**
 * Developer utility: syntax-check every frontend module and verify that the
 * import graph resolves.
 *
 * Catches the two mistakes that are otherwise only visible as a blank page in
 * the browser: a syntax error, and an `import` pointing at a file or an export
 * that does not exist.
 *
 *   node tools/check_js.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web', 'js');

/** Recursively collect .js files, skipping vendored code. */
function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'vendor') continue;
      out.push(...collect(full));
    } else if (name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = collect(WEB);
let errors = 0;

// --- pass 1: syntax + collect exports/imports ------------------------------

/** @type {Map<string, {exports:Set<string>, imports:Array}>} */
const modules = new Map();

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);

  // Parsing as an ES module surfaces syntax errors without executing anything.
  // `vm.SourceTextModule` needs --experimental-vm-modules, so fall back to a
  // dynamic import of the module's own syntax check when it is unavailable.
  try {
    if (typeof vm.SourceTextModule === 'function') {
      new vm.SourceTextModule(source, { identifier: file });
    } else {
      // `new Function` rejects import/export, so strip module syntax to a form
      // that still surfaces every other syntax error.
      const stripped = source
        .replace(/^\s*import\s[\s\S]*?from\s*['"][^'"]+['"];?\s*$/gm, '')
        .replace(/^\s*import\s*['"][^'"]+['"];?\s*$/gm, '')
        .replace(/^\s*export\s+default\s+/gm, 'void ')
        .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '')
        .replace(/^\s*export\s+/gm, '');
      new Function(stripped);
    }
  } catch (error) {
    console.error(`SYNTAX  ${rel}\n        ${error.message}`);
    errors++;
    continue;
  }

  const exports = new Set();
  // export function/class/const/let NAME
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    exports.add(m[1]);
  }
  // export { a, b as c }
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const as = piece.split(/\s+as\s+/);
      exports.add((as[1] || as[0]).trim());
    }
  }
  if (/^export\s+default/m.test(source)) exports.add('default');

  const imports = [];
  for (const m of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    imports.push({ clause: m[1], spec: m[2] });
  }

  modules.set(file, { exports, imports, rel });
}

// --- pass 2: resolve imports ----------------------------------------------

for (const [file, info] of modules) {
  for (const { clause, spec } of info.imports) {
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;   // bare: skip

    const target = spec.startsWith('/')
      ? join(ROOT, 'web', spec)
      : resolve(dirname(file), spec);

    const targetInfo = modules.get(target);
    if (!targetInfo) {
      console.error(`MISSING ${info.rel}\n        imports "${spec}" which does not exist`);
      errors++;
      continue;
    }

    // Named imports: verify each name is actually exported.
    const braces = clause.match(/\{([^}]*)\}/);
    if (!braces) continue;
    for (const part of braces[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const name = piece.split(/\s+as\s+/)[0].trim();
      if (!targetInfo.exports.has(name)) {
        console.error(`EXPORT  ${info.rel}\n        imports { ${name} } from "${spec}" but it is not exported`);
        errors++;
      }
    }
  }
}

console.log(
  errors === 0
    ? `OK: ${files.length} modules parsed, imports resolve`
    : `${errors} problem(s) found across ${files.length} modules`,
);
process.exit(errors === 0 ? 0 : 1);
