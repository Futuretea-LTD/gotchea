// fanIn by import resolution plus name matching (PLAN.md §5, §10 assumption 10).
// No type resolution: a symbol counts a file when that file imports it (by name,
// or through a namespace whose members it references) and uses the identifier.
import { posix } from 'node:path';
import { baseSymbolName, parentDir } from '../model/ids.js';
import type { ImportRef } from '../parse/parser.js';

export interface FileReferences {
  path: string;
  lang: string;
  imports: readonly ImportRef[];
  idents: ReadonlySet<string>;
}

interface Edge {
  importer: string;
  /** imported name → local binding. */
  names: Map<string, string>;
  /** Namespace import: null local = every export counts (re-export, bare require). */
  namespace: { local: string | null } | null;
}

export interface FanInIndex {
  /** Distinct files importing `path`. */
  file(path: string): number;
  /** Distinct files referencing any of `symbolPaths` (group members) declared in `path`. */
  symbol(path: string, symbolPaths: readonly (readonly string[])[]): number;
  /** Distinct files outside `dir` importing any file inside it. */
  module(dir: string): number;
  importers(path: string): ReadonlySet<string>;
}

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/** Resolves a specifier from `fromPath` to a known repo file, or null (external / unresolved). */
export function resolveImport(fromPath: string, lang: string, specifier: string, known: ReadonlySet<string>): string | null {
  return lang === 'python' ? resolvePython(fromPath, specifier, known) : resolveScript(fromPath, specifier, known);
}

function resolveScript(fromPath: string, specifier: string, known: ReadonlySet<string>): string | null {
  if (!(specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../'))) return null;
  const base = joinInside(parentDir(fromPath), specifier);
  if (base === null) return null;
  const candidates: string[] = [];
  const ext = posix.extname(base);
  const mapped = JS_TO_TS[ext];
  if (mapped) for (const m of mapped) candidates.push(base.slice(0, -ext.length) + m);
  candidates.push(base);
  for (const e of TS_EXTS) candidates.push(base + e);
  for (const e of TS_EXTS) candidates.push(`${base}/index${e}`);
  return candidates.find((c) => known.has(c)) ?? null;
}

function resolvePython(fromPath: string, specifier: string, known: ReadonlySet<string>): string | null {
  const dots = /^\.*/.exec(specifier)![0].length;
  const rest = specifier.slice(dots).replace(/\./g, '/');
  const bases: (string | null)[] = [];
  if (dots > 0) {
    let dir: string | null = parentDir(fromPath);
    for (let i = 1; i < dots && dir !== null; i++) dir = dir === '.' ? null : parentDir(dir);
    bases.push(dir === null ? null : rest ? joinInside(dir, rest) : dir);
  } else if (rest) {
    bases.push(rest, `src/${rest}`);
  }
  for (const b of bases) {
    if (b === null) continue;
    const prefix = b === '.' ? '' : `${b}/`;
    for (const c of [`${b}.py`, `${prefix}__init__.py`]) if (known.has(c)) return c;
  }
  return null;
}

/** Joins and normalizes; null when the result escapes the repo root. */
function joinInside(dir: string, rel: string): string | null {
  const joined = posix.normalize(posix.join(dir, rel));
  if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) return null;
  return joined.endsWith('/') ? joined.slice(0, -1) || '.' : joined;
}

/** Python `from pkg import name`: `name` may be a submodule; returns that file when it is. */
function pythonSubmodule(fromPath: string, specifier: string, name: string, known: ReadonlySet<string>): string | null {
  const spec = specifier.endsWith('.') ? `${specifier}${name}` : `${specifier}.${name}`;
  return resolvePython(fromPath, spec, known);
}

export function buildFanIn(files: readonly FileReferences[], known: ReadonlySet<string>): FanInIndex {
  const edges = new Map<string, Edge[]>();
  const idents = new Map<string, ReadonlySet<string>>();
  const addEdge = (target: string, importer: string, names: ImportRef['names'], namespace: Edge['namespace']) => {
    if (target === importer) return;
    const edge: Edge = { importer, names: new Map(names.map((n) => [n.imported, n.local])), namespace };
    const list = edges.get(target);
    if (list) list.push(edge);
    else edges.set(target, [edge]);
  };

  for (const f of files) {
    idents.set(f.path, f.idents);
    for (const ref of f.imports) {
      if (f.lang === 'python' && ref.names.length > 0) {
        // `from pkg import sub` binds submodules as namespaces; the rest are names of pkg.
        const plain: ImportRef['names'] = [];
        for (const n of ref.names) {
          const sub = pythonSubmodule(f.path, ref.specifier, n.imported, known);
          if (sub) addEdge(sub, f.path, [], { local: n.local });
          else plain.push(n);
        }
        if (plain.length === 0) continue;
        const target = resolveImport(f.path, f.lang, ref.specifier, known);
        if (target) addEdge(target, f.path, plain, ref.namespace ?? null);
        continue;
      }
      const target = resolveImport(f.path, f.lang, ref.specifier, known);
      if (target) addEdge(target, f.path, ref.names, ref.namespace ?? null);
    }
  }

  const importers = (path: string): Set<string> => new Set((edges.get(path) ?? []).map((e) => e.importer));

  const references = (e: Edge, symbolPath: readonly string[]): boolean => {
    const used = idents.get(e.importer) ?? new Set<string>();
    const top = baseSymbolName(symbolPath[0] ?? '');
    const member = symbolPath.length > 1 ? baseSymbolName(symbolPath[symbolPath.length - 1]!) : null;
    let reachesTop = false;
    const local = e.names.get(top);
    if (local !== undefined && used.has(local)) reachesTop = true;
    else if (e.namespace) reachesTop = e.namespace.local === null || used.has(top);
    if (!reachesTop) return false;
    return member === null || used.has(member);
  };

  return {
    file: (path) => importers(path).size,
    importers,
    symbol(path, symbolPaths) {
      const hits = new Set<string>();
      for (const e of edges.get(path) ?? []) {
        if (symbolPaths.some((sp) => !sp[0]?.startsWith('~') && references(e, sp))) hits.add(e.importer);
      }
      return hits.size;
    },
    module(dir) {
      const inside = (p: string) => dir === '.' || p.startsWith(`${dir}/`);
      const hits = new Set<string>();
      for (const [target, list] of edges) {
        if (!inside(target)) continue;
        for (const e of list) if (!inside(e.importer)) hits.add(e.importer);
      }
      return hits.size;
    },
  };
}
