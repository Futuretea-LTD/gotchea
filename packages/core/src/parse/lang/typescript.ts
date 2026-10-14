// One implementation for the TS-family grammars (typescript, tsx, javascript).
// The JavaScript grammar is a subset of the TypeScript one apart from a few
// node names (e.g. `field_definition` vs `public_field_definition`).
import type { Node, TreeCursor } from 'web-tree-sitter';
import type { GrammarName } from '../loader.js';
import type { ImportName, ImportRef, LanguageParser, OffsetRange, ParsedFile, SymbolNode } from '../parser.js';
import {
  collectRanges,
  countDecisions,
  rootOf,
  stringContent,
  symbol,
  startLine,
  TreeSitterLanguageParser,
  walk,
} from '../tree-utils.js';

const COMMENT_TYPES: ReadonlySet<string> = new Set(['comment', 'html_comment']);

const DECISION_TYPES: ReadonlySet<string> = new Set([
  'if_statement',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'switch_case',
  'catch_clause',
  'ternary_expression',
]);
const LOGICAL_OPERATORS: ReadonlySet<string> = new Set(['&&', '||', '??']);

const FUNCTION_DECLS: ReadonlySet<string> = new Set(['function_declaration', 'generator_function_declaration']);
const CLASS_DECLS: ReadonlySet<string> = new Set(['class_declaration', 'abstract_class_declaration', 'class']);
const FUNCTION_VALUES: ReadonlySet<string> = new Set(['arrow_function', 'function_expression', 'generator_function', 'function']);
const OTHER_DECLS: ReadonlySet<string> = new Set(['interface_declaration', 'type_alias_declaration', 'enum_declaration']);
const NAMESPACE_DECLS: ReadonlySet<string> = new Set(['internal_module', 'module']);
const VARIABLE_DECLS: ReadonlySet<string> = new Set(['lexical_declaration', 'variable_declaration']);

/** Statement containers walked when looking for symbols nested in a function body. */
const BODY_CONTAINERS: ReadonlySet<string> = new Set([
  'statement_block',
  'if_statement',
  'else_clause',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'try_statement',
  'catch_clause',
  'finally_clause',
  'switch_statement',
  'switch_body',
  'switch_case',
  'switch_default',
  'labeled_statement',
]);

const IDENTIFIER_TYPES: ReadonlySet<string> = new Set([
  'identifier',
  'property_identifier',
  'type_identifier',
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
]);
const IMPORT_SUBTREES: ReadonlySet<string> = new Set(['import_statement', 'import_require_clause', 'import_alias']);

interface TsFamilyOptions {
  lang: string;
  extensions: readonly string[];
  grammar: GrammarName;
}

class TsFamilyParser extends TreeSitterLanguageParser {
  readonly lang: string;
  readonly extensions: readonly string[];
  protected readonly grammar: GrammarName;

  constructor(o: TsFamilyOptions) {
    super();
    this.lang = o.lang;
    this.extensions = o.extensions;
    this.grammar = o.grammar;
  }

  symbols(f: ParsedFile): SymbolNode[] {
    return topLevel(rootOf(f));
  }

  commentRanges(f: ParsedFile): OffsetRange[] {
    return collectRanges(rootOf(f), COMMENT_TYPES);
  }

  complexity(f: ParsedFile, startLine: number, endLine: number): number {
    return countDecisions(rootOf(f), startLine, endLine, isDecision);
  }

  imports(f: ParsedFile): ImportRef[] {
    const out: ImportRef[] = [];
    walk(rootOf(f), (c) => {
      switch (c.nodeType) {
        case 'import_statement':
          pushImport(c.currentNode, out);
          return false;
        case 'export_statement': {
          const n = c.currentNode;
          if (n.childForFieldName('source')) {
            pushReExport(n, out);
            return false;
          }
          return true;
        }
        case 'call_expression':
          pushRequire(c.currentNode, out);
          return true;
        default:
          return true;
      }
    });
    return out;
  }

  identifiers(f: ParsedFile): Set<string> {
    const out = new Set<string>();
    walk(rootOf(f), (c) => {
      const t = c.nodeType;
      if (IDENTIFIER_TYPES.has(t)) {
        out.add(c.nodeText);
        return false;
      }
      if (IMPORT_SUBTREES.has(t)) return false;
      if (t === 'export_statement' && c.currentNode.childForFieldName('source')) return false;
      return true;
    });
    return out;
  }
}

function isDecision(c: TreeCursor): boolean {
  const t = c.nodeType;
  if (DECISION_TYPES.has(t)) return true;
  if (t !== 'binary_expression') return false;
  const op = c.currentNode.childForFieldName('operator');
  return op !== null && LOGICAL_OPERATORS.has(op.type);
}

// ---------------------------------------------------------------- symbols

/** Symbols declared directly in a program or namespace body. */
function topLevel(container: Node): SymbolNode[] {
  const out: SymbolNode[] = [];
  for (const stmt of container.namedChildren) {
    switch (stmt.type) {
      case 'export_statement': {
        const inner = stmt.childForFieldName('declaration') ?? stmt.childForFieldName('value');
        if (inner) out.push(...declaration(inner, stmt, true));
        break;
      }
      case 'ambient_declaration': {
        const inner = stmt.namedChildren.find((n) => n.type !== 'comment');
        if (inner) out.push(...declaration(inner, stmt, false));
        break;
      }
      case 'expression_statement': {
        const inner = stmt.firstNamedChild;
        if (inner && stmt.namedChildCount === 1 && inner.type === 'internal_module') out.push(...declaration(inner, stmt, false));
        break;
      }
      default:
        out.push(...declaration(stmt, stmt, false));
    }
  }
  return out;
}

/** Symbols for a declaration node; `outer` is the statement that owns its line range. */
function declaration(node: Node, outer: Node, exported: boolean): SymbolNode[] {
  const t = node.type;
  if (FUNCTION_DECLS.has(t)) return [symbol(nameOf(node), 'function', outer, outer, functionChildren(node))];
  if (CLASS_DECLS.has(t)) return [symbol(nameOf(node), 'class', outer, outer, classChildren(node))];
  if (OTHER_DECLS.has(t)) return [symbol(nameOf(node), 'other', outer, outer)];
  if (NAMESPACE_DECLS.has(t)) {
    const body = node.childForFieldName('body');
    return [symbol(nameOf(node), 'other', outer, outer, body ? topLevel(body) : [])];
  }
  if (VARIABLE_DECLS.has(t)) return variables(node, outer, true);
  // `export default function () {}` / `export default () => {}`
  if (exported && FUNCTION_VALUES.has(t)) return [symbol(nameOf(node), 'function', outer, outer, functionChildren(node))];
  return [];
}

function nameOf(n: Node): string {
  const name = n.childForFieldName('name');
  if (!name) return 'default';
  return name.type === 'string' ? stringContent(name) : name.text;
}

/**
 * One symbol per identifier-named declarator. With `includeValues`, plain
 * values become 'variable' symbols; otherwise only function-valued ones count.
 */
function variables(decl: Node, outer: Node, includeValues: boolean): SymbolNode[] {
  const declarators = decl.namedChildren.filter((n) => n.type === 'variable_declarator');
  const single = declarators.length === 1;
  const out: SymbolNode[] = [];
  for (const d of declarators) {
    const name = d.childForFieldName('name');
    if (!name || name.type !== 'identifier') continue;
    const value = d.childForFieldName('value');
    const isFn = value !== null && FUNCTION_VALUES.has(value.type);
    if (!isFn && !includeValues) continue;
    const range = single ? outer : d;
    out.push(symbol(name.text, isFn ? 'function' : 'variable', range, range, isFn ? functionChildren(value) : []));
  }
  return out;
}

/** Nested functions/classes/function-valued consts at statement level in a function body. */
function functionChildren(fn: Node): SymbolNode[] {
  const body = fn.childForFieldName('body');
  const out: SymbolNode[] = [];
  if (body && body.type === 'statement_block') collectNested(body, out);
  return out;
}

function collectNested(container: Node, out: SymbolNode[]): void {
  for (const stmt of container.namedChildren) {
    const t = stmt.type;
    if (FUNCTION_DECLS.has(t)) out.push(symbol(nameOf(stmt), 'function', stmt, stmt, functionChildren(stmt)));
    else if (CLASS_DECLS.has(t)) out.push(symbol(nameOf(stmt), 'class', stmt, stmt, classChildren(stmt)));
    else if (VARIABLE_DECLS.has(t)) out.push(...variables(stmt, stmt, false));
    else if (BODY_CONTAINERS.has(t)) collectNested(stmt, out);
  }
}

function classChildren(cls: Node): SymbolNode[] {
  const body = cls.childForFieldName('body');
  if (!body) return [];
  const out: SymbolNode[] = [];
  for (const m of body.namedChildren) {
    if (m.type === 'method_definition') {
      out.push(symbol(memberName(m.childForFieldName('name')), 'method', withDecorators(m), m, functionChildren(m)));
    } else if (m.type === 'public_field_definition' || m.type === 'field_definition') {
      const value = m.childForFieldName('value');
      if (!value || !FUNCTION_VALUES.has(value.type)) continue;
      const name = m.childForFieldName('name') ?? m.childForFieldName('property');
      out.push(symbol(memberName(name), 'method', withDecorators(m), m, functionChildren(value)));
    }
  }
  return out;
}

function memberName(n: Node | null): string {
  if (!n) return 'anonymous';
  return n.type === 'string' ? stringContent(n) : n.text;
}

/** First node of a class member's range: preceding decorator siblings are included. */
function withDecorators(m: Node): Node {
  let first = m;
  for (let p = m.previousNamedSibling; p && p.type === 'decorator'; p = p.previousNamedSibling) first = p;
  return first;
}

// ---------------------------------------------------------------- imports

function pushImport(stmt: Node, out: ImportRef[]): void {
  const req = stmt.namedChildren.find((n) => n.type === 'import_require_clause');
  if (req) {
    const src = req.childForFieldName('source');
    const local = req.namedChildren.find((n) => n.type === 'identifier');
    if (src) out.push({ specifier: stringContent(src), names: [], namespace: { local: local?.text ?? null }, line: startLine(stmt) });
    return;
  }
  const src = stmt.childForFieldName('source');
  if (!src) return;
  const ref: ImportRef = { specifier: stringContent(src), names: [], line: startLine(stmt) };
  const clause = stmt.namedChildren.find((n) => n.type === 'import_clause');
  for (const part of clause?.namedChildren ?? []) {
    if (part.type === 'identifier') {
      ref.names.push({ imported: 'default', local: part.text });
    } else if (part.type === 'namespace_import') {
      const id = part.namedChildren.find((n) => n.type === 'identifier');
      ref.namespace = { local: id?.text ?? null };
    } else if (part.type === 'named_imports') {
      for (const spec of part.namedChildren) {
        if (spec.type !== 'import_specifier') continue;
        const name = spec.childForFieldName('name');
        if (!name) continue;
        const imported = memberName(name);
        const alias = spec.childForFieldName('alias');
        ref.names.push({ imported, local: alias ? alias.text : imported });
      }
    }
  }
  out.push(ref);
}

function pushReExport(stmt: Node, out: ImportRef[]): void {
  const src = stmt.childForFieldName('source');
  if (!src) return;
  const ref: ImportRef = { specifier: stringContent(src), names: [], line: startLine(stmt) };
  const ns = stmt.namedChildren.find((n) => n.type === 'namespace_export');
  const clause = stmt.namedChildren.find((n) => n.type === 'export_clause');
  if (ns) {
    const id = ns.namedChildren.find((n) => n.type !== 'comment');
    ref.namespace = { local: id ? memberName(id) : null };
  } else if (clause) {
    for (const spec of clause.namedChildren) {
      if (spec.type !== 'export_specifier') continue;
      const name = spec.childForFieldName('name');
      if (!name) continue;
      const imported = memberName(name);
      const alias = spec.childForFieldName('alias');
      ref.names.push({ imported, local: alias ? memberName(alias) : imported });
    }
  } else {
    ref.namespace = { local: null }; // export * from
  }
  out.push(ref);
}

/** `require('x')` with a single string literal argument. */
function pushRequire(call: Node, out: ImportRef[]): void {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'identifier' || fn.text !== 'require') return;
  const args = call.childForFieldName('arguments');
  const arg = args?.namedChildren.filter((n) => n.type !== 'comment');
  if (!arg || arg.length !== 1 || arg[0]?.type !== 'string') return;
  const ref: ImportRef = { specifier: stringContent(arg[0]), names: [], line: startLine(call) };
  const parent = call.parent;
  const binding = parent?.type === 'variable_declarator' && parent.childForFieldName('value')?.equals(call) ? parent.childForFieldName('name') : null;
  if (binding?.type === 'object_pattern') {
    ref.names = destructuredNames(binding);
    if (ref.names.length === 0) ref.namespace = { local: null };
  } else {
    ref.namespace = { local: binding?.type === 'identifier' ? binding.text : null };
  }
  out.push(ref);
}

function destructuredNames(pattern: Node): ImportName[] {
  const names: ImportName[] = [];
  for (const p of pattern.namedChildren) {
    if (p.type === 'shorthand_property_identifier_pattern') {
      names.push({ imported: p.text, local: p.text });
    } else if (p.type === 'pair_pattern') {
      const key = p.childForFieldName('key');
      const value = p.childForFieldName('value');
      if (key && value?.type === 'identifier') names.push({ imported: memberName(key), local: value.text });
    } else if (p.type === 'object_assignment_pattern') {
      // `{ a = 1 } = require(...)`
      const left = p.childForFieldName('left');
      if (left?.type === 'shorthand_property_identifier_pattern') names.push({ imported: left.text, local: left.text });
    }
  }
  return names;
}

// ---------------------------------------------------------------- factories

export function createTypeScriptParser(): LanguageParser {
  return new TsFamilyParser({ lang: 'typescript', extensions: ['.ts', '.mts', '.cts'], grammar: 'typescript' });
}

export function createTsxParser(): LanguageParser {
  return new TsFamilyParser({ lang: 'typescript', extensions: ['.tsx'], grammar: 'tsx' });
}

export function createJavaScriptParser(): LanguageParser {
  return new TsFamilyParser({ lang: 'javascript', extensions: ['.js', '.jsx', '.mjs', '.cjs'], grammar: 'javascript' });
}
