// Smoke test for the riskiest dependency: web-tree-sitter must initialize in
// Node and load the prebuilt WASM grammars copied from @vscode/tree-sitter-wasm
// into packages/core/wasm/ (resolved exactly as the shipped package does).
// (tree-sitter-wasms was rejected: its 0.20-era grammars fail to load on
// web-tree-sitter 0.27. See PLAN.md §10, assumption 24.)
import { beforeAll, describe, expect, it } from 'vitest';
import { Language, Parser } from 'web-tree-sitter';
import { grammarPath as grammar, type GrammarName } from '../src/assets.js';
import { initTreeSitter } from '../src/parse/loader.js';

async function parse(grammarName: GrammarName, source: string) {
  const parser = new Parser();
  parser.setLanguage(await Language.load(grammar(grammarName)));
  const tree = parser.parse(source);
  if (!tree) throw new Error(`parse returned null for ${grammarName}`);
  return tree.rootNode;
}

describe('web-tree-sitter + WASM grammars', () => {
  beforeAll(async () => {
    await initTreeSitter();
  });

  it('parses TypeScript', async () => {
    const root = await parse(
      'typescript',
      'export class Store {\n  get(key: string): number | undefined { return undefined; }\n}\nexport const add = (a: number, b: number): number => a + b;\n',
    );
    expect(root.type).toBe('program');
    expect(root.hasError).toBe(false);
    const cls = root.descendantsOfType('class_declaration')[0];
    expect(cls?.childForFieldName('name')?.text).toBe('Store');
    expect(root.descendantsOfType('method_definition')).toHaveLength(1);
    expect(root.descendantsOfType('arrow_function')).toHaveLength(1);
  });

  it('parses TSX', async () => {
    const root = await parse('tsx', 'export const App = () => <div className="x">hi</div>;\n');
    expect(root.hasError).toBe(false);
    expect(root.descendantsOfType('jsx_element')).toHaveLength(1);
  });

  it('parses JavaScript', async () => {
    const root = await parse('javascript', 'function f(a) { return a ?? 1; }\n');
    expect(root.hasError).toBe(false);
    expect(root.descendantsOfType('function_declaration')).toHaveLength(1);
  });

  it('parses Python', async () => {
    const root = await parse(
      'python',
      'class Greeter:\n    """Says hi."""\n    def hi(self, name):\n        if name:\n            return f"hi {name}"\n        return "hi"\n',
    );
    expect(root.type).toBe('module');
    expect(root.hasError).toBe(false);
    const fn = root.descendantsOfType('function_definition')[0];
    expect(fn?.childForFieldName('name')?.text).toBe('hi');
    expect(root.descendantsOfType('if_statement')).toHaveLength(1);
  });

  it('reports syntax errors as a partial tree instead of throwing', async () => {
    const root = await parse('typescript', 'function broken( {\n');
    expect(root.hasError).toBe(true);
  });
});
