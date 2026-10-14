// Python LanguageParser on tree-sitter-python.
import type { Node } from 'web-tree-sitter';
import type { GrammarName } from '../loader.js';
import type { ImportRef, LanguageParser, OffsetRange, ParsedFile, SymbolNode } from '../parser.js';
import { countDecisions, rootOf, startLine, symbol, TreeSitterLanguageParser, walk } from '../tree-utils.js';

const DECISION_TYPES: ReadonlySet<string> = new Set([
  'if_statement',
  'elif_clause',
  'for_statement',
  'while_statement',
  'except_clause',
  'except_group_clause',
  'conditional_expression',
  'boolean_operator',
  'if_clause',
  'case_clause',
]);

/** Statement containers walked when looking for definitions nested in a function body. */
const BODY_CONTAINERS: ReadonlySet<string> = new Set([
  'block',
  'if_statement',
  'elif_clause',
  'else_clause',
  'for_statement',
  'while_statement',
  'try_statement',
  'except_clause',
  'except_group_clause',
  'finally_clause',
  'with_statement',
  'match_statement',
  'case_clause',
]);

const STRING_TYPES: ReadonlySet<string> = new Set(['string', 'concatenated_string']);
const DOCSTRING_PREFIX = /^[rRuU]*['"]/;
const IMPORT_SUBTREES: ReadonlySet<string> = new Set(['import_statement', 'import_from_statement', 'future_import_statement']);

class PythonParser extends TreeSitterLanguageParser {
  readonly lang = 'python';
  readonly extensions: readonly string[] = ['.py'];
  protected readonly grammar: GrammarName = 'python';

  symbols(f: ParsedFile): SymbolNode[] {
    const out: SymbolNode[] = [];
    for (const stmt of rootOf(f).namedChildren) {
      const def = definition(stmt, 'function');
      if (def) {
        out.push(def);
        continue;
      }
      if (stmt.type !== 'expression_statement') continue;
      const assign = stmt.firstNamedChild;
      if (assign?.type !== 'assignment') continue;
      const left = assign.childForFieldName('left');
      if (left?.type === 'identifier') out.push(symbol(left.text, 'variable', stmt, stmt));
    }
    return out;
  }

  commentRanges(f: ParsedFile): OffsetRange[] {
    const root = rootOf(f);
    const out: OffsetRange[] = [];
    const docstring = (body: Node | null): void => {
      const first = body?.namedChildren.find((n) => n.type !== 'comment');
      if (first?.type !== 'expression_statement' || first.namedChildCount !== 1) return;
      const expr = first.firstNamedChild;
      // Only plain/raw/unicode literals are docstrings; f-strings and bytes are code.
      if (expr && STRING_TYPES.has(expr.type) && DOCSTRING_PREFIX.test(expr.text)) out.push({ start: first.startIndex, end: first.endIndex });
    };
    docstring(root);
    walk(root, (c) => {
      const t = c.nodeType;
      if (t === 'comment') {
        out.push({ start: c.startIndex, end: c.endIndex });
        return false;
      }
      if (t === 'function_definition' || t === 'class_definition') docstring(c.currentNode.childForFieldName('body'));
      return true;
    });
    return out.sort((a, b) => a.start - b.start);
  }

  complexity(f: ParsedFile, startLine: number, endLine: number): number {
    return countDecisions(rootOf(f), startLine, endLine, (c) => DECISION_TYPES.has(c.nodeType));
  }

  imports(f: ParsedFile): ImportRef[] {
    const out: ImportRef[] = [];
    walk(rootOf(f), (c) => {
      if (c.nodeType === 'import_statement') {
        pushImport(c.currentNode, out);
        return false;
      }
      if (c.nodeType === 'import_from_statement') {
        pushFromImport(c.currentNode, out);
        return false;
      }
      return true;
    });
    return out;
  }

  identifiers(f: ParsedFile): Set<string> {
    const out = new Set<string>();
    walk(rootOf(f), (c) => {
      if (c.nodeType === 'identifier') {
        out.add(c.nodeText);
        return false;
      }
      return !IMPORT_SUBTREES.has(c.nodeType);
    });
    return out;
  }
}

// ---------------------------------------------------------------- symbols

/**
 * Symbol for a function/class definition (optionally decorated); null for
 * anything else. `fnKind` is the kind given to functions at this position.
 */
function definition(stmt: Node, fnKind: 'function' | 'method'): SymbolNode | null {
  const def = stmt.type === 'decorated_definition' ? stmt.childForFieldName('definition') : stmt;
  if (!def) return null;
  const name = def.childForFieldName('name')?.text ?? 'anonymous';
  if (def.type === 'function_definition') return symbol(name, fnKind, stmt, stmt, functionChildren(def));
  if (def.type === 'class_definition') return symbol(name, 'class', stmt, stmt, classChildren(def));
  return null;
}

function classChildren(cls: Node): SymbolNode[] {
  const out: SymbolNode[] = [];
  for (const stmt of cls.childForFieldName('body')?.namedChildren ?? []) {
    const def = definition(stmt, 'method');
    if (def) out.push(def);
  }
  return out;
}

function functionChildren(fn: Node): SymbolNode[] {
  const out: SymbolNode[] = [];
  const body = fn.childForFieldName('body');
  if (body) collectNested(body, out);
  return out;
}

function collectNested(container: Node, out: SymbolNode[]): void {
  for (const stmt of container.namedChildren) {
    const def = definition(stmt, 'function');
    if (def) out.push(def);
    else if (BODY_CONTAINERS.has(stmt.type)) collectNested(stmt, out);
  }
}

// ---------------------------------------------------------------- imports

function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

/** `import a.b.c, d as e` → one ImportRef per imported module. */
function pushImport(stmt: Node, out: ImportRef[]): void {
  for (const n of stmt.childrenForFieldName('name')) {
    if (n.type === 'dotted_name') {
      const first = n.firstNamedChild;
      out.push({ specifier: compact(n.text), names: [], namespace: { local: first?.text ?? null }, line: startLine(stmt) });
    } else if (n.type === 'aliased_import') {
      const name = n.childForFieldName('name');
      const alias = n.childForFieldName('alias');
      if (name) out.push({ specifier: compact(name.text), names: [], namespace: { local: alias?.text ?? null }, line: startLine(stmt) });
    }
  }
}

function pushFromImport(stmt: Node, out: ImportRef[]): void {
  const mod = stmt.childForFieldName('module_name');
  if (!mod) return;
  const ref: ImportRef = { specifier: compact(mod.text), names: [], line: startLine(stmt) };
  for (const n of stmt.childrenForFieldName('name')) {
    if (n.type === 'dotted_name') {
      ref.names.push({ imported: compact(n.text), local: compact(n.text) });
    } else if (n.type === 'aliased_import') {
      const name = n.childForFieldName('name');
      const alias = n.childForFieldName('alias');
      if (name && alias) ref.names.push({ imported: compact(name.text), local: alias.text });
    }
  }
  if (stmt.namedChildren.some((n) => n.type === 'wildcard_import')) ref.namespace = { local: null };
  out.push(ref);
}

export function createPythonParser(): LanguageParser {
  return new PythonParser();
}
