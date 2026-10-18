// The code preview printed above a quiz question. Highlighting is a small hand-rolled lexer
// (comments, strings, numbers, keywords) on picocolors: a full highlighter would add a large
// dependency for a few dozen lines of colour. With colours off, the output carries no ANSI codes.
// The preview is sanitized again here, not only in core: this is the last stop before the TTY.
import { type PublicCodePreview, sanitizeTerminalText } from 'gotchea-core';
import type { Colors } from '../context.js';

interface Syntax {
  keywords: ReadonlySet<string>;
  /** Line-comment openers, e.g. `//` or `#`. */
  line: readonly string[];
  /** Block comment delimiters, when the language has them. */
  block?: readonly [string, string];
  /** String quote characters. */
  quotes: string;
  /** Delimiters of strings that may span lines and close with the same delimiter, e.g. `"""`. */
  longQuotes?: readonly string[];
  /** Rust: `'a` is a lifetime or label unless it closes as a char literal. */
  lifetimes?: boolean;
}

const words = (s: string): ReadonlySet<string> => new Set(s.split(' '));

const JS_KEYWORDS =
  'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface keyof let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while yield';

const C_LIKE = { line: ['//'], block: ['/*', '*/'] as const, quotes: `"'` };

const SYNTAX: Record<string, Syntax> = {
  typescript: { ...C_LIKE, keywords: words(JS_KEYWORDS), quotes: `"'\`` },
  javascript: { ...C_LIKE, keywords: words(JS_KEYWORDS), quotes: `"'\`` },
  python: {
    keywords: words(
      'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield',
    ),
    line: ['#'],
    quotes: `"'`,
    longQuotes: ['"""', "'''"],
  },
  go: {
    ...C_LIKE,
    keywords: words('break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var'),
    quotes: `"'\``,
  },
  rust: {
    ...C_LIKE,
    keywords: words('as async await break const continue crate else enum false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'),
    lifetimes: true,
  },
  java: {
    ...C_LIKE,
    keywords: words(
      'abstract boolean break case catch char class const continue default do double else enum extends false final finally float for if implements import instanceof int interface long new null package private protected public return short static super switch this throw throws true try void volatile while',
    ),
  },
};

type Kind = 'comment' | 'string' | 'number' | 'keyword' | 'plain';

/** A token left open at the end of a line (block comment or multi-line string) and what closes it. */
interface Open {
  kind: 'comment' | 'string';
  close: string;
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /\d[\w.]*/y;
const CHAR_LITERAL = /'(?:\\.[^']*|[^\\'])'/uy;
const LIFETIME = /'[A-Za-z_]\w*/y;

/** Index just past `open.close` at or after `from`, or -1. Strings honour backslash escapes, comments do not. */
function closeAt(line: string, from: number, open: Open): number {
  for (let j = from; j < line.length; ) {
    if (line.startsWith(open.close, j)) return j + open.close.length;
    j += open.kind === 'string' && line[j] === '\\' ? 2 : 1;
  }
  return -1;
}

/** Splits one line into tokens. `open` carries a block comment or multi-line string across lines. */
function tokenize(line: string, syntax: Syntax, open: Open | null): { tokens: [Kind, string][]; open: Open | null } {
  const tokens: [Kind, string][] = [];
  let i = 0;
  const push = (kind: Kind, text: string) => {
    const last = tokens[tokens.length - 1];
    if (last && last[0] === kind) last[1] += text;
    else tokens.push([kind, text]);
  };
  /** Emits the open token from `i` up to its closer; false when it runs past the end of the line. */
  const consume = (o: Open, from: number): boolean => {
    const end = closeAt(line, from, o);
    push(o.kind, line.slice(i, end < 0 ? line.length : end));
    i = end < 0 ? line.length : end;
    return end >= 0;
  };
  if (open && !consume(open, 0)) return { tokens, open };
  while (i < line.length) {
    const rest = line.slice(i);
    if (syntax.line.some((o) => rest.startsWith(o))) {
      push('comment', rest);
      break;
    }
    const long = syntax.longQuotes?.find((q) => rest.startsWith(q));
    const opener: [Open, number] | undefined =
      syntax.block && rest.startsWith(syntax.block[0])
        ? [{ kind: 'comment', close: syntax.block[1] }, syntax.block[0].length]
        : long
          ? [{ kind: 'string', close: long }, long.length]
          : undefined;
    if (opener) {
      if (!consume(opener[0], i + opener[1])) return { tokens, open: opener[0] };
      continue;
    }
    const ch = line[i]!;
    if (syntax.lifetimes && ch === "'") {
      CHAR_LITERAL.lastIndex = i;
      const char = CHAR_LITERAL.exec(line);
      LIFETIME.lastIndex = i;
      const lifetime = char ? null : LIFETIME.exec(line);
      const text = char?.[0] ?? lifetime?.[0] ?? ch;
      push(char ? 'string' : lifetime ? 'keyword' : 'plain', text);
      i += text.length;
      continue;
    }
    if (syntax.quotes.includes(ch)) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      push('string', line.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    IDENT.lastIndex = i;
    const ident = IDENT.exec(line);
    if (ident) {
      push(syntax.keywords.has(ident[0]) ? 'keyword' : 'plain', ident[0]);
      i += ident[0].length;
      continue;
    }
    NUMBER.lastIndex = i;
    const num = NUMBER.exec(line);
    if (num) {
      push('number', num[0]);
      i += num[0].length;
      continue;
    }
    push('plain', ch);
    i++;
  }
  return { tokens, open: null };
}

/** Tab stops every 4 columns, counted in code points, so the code stays aligned under the gutter. */
function expandTabs(line: string): string {
  let out = '';
  let col = 0;
  for (const ch of line) {
    const text = ch === '\t' ? ' '.repeat(4 - (col % 4)) : ch;
    out += text;
    col += ch === '\t' ? text.length : 1;
  }
  return out;
}

function highlighter(pc: Colors, language: string): (line: string) => string {
  // hasOwn: a language such as `constructor` must not resolve to an Object.prototype member.
  const syntax = Object.hasOwn(SYNTAX, language) ? SYNTAX[language] : undefined;
  if (!syntax || !pc.isColorSupported) return (line) => line;
  const paint: Record<Kind, (s: string) => string> = { comment: pc.dim, string: pc.green, number: pc.yellow, keyword: pc.magenta, plain: (s) => s };
  let open: Open | null = null;
  return (line) => {
    const r = tokenize(line, syntax, open);
    open = r.open;
    return r.tokens.map(([kind, text]) => paint[kind](text)).join('');
  };
}

/** Header `path:start-end (language)`, then the lines numbered from `startLine`, right-aligned. */
export function codeBlockLines(pc: Colors, code: PublicCodePreview): string[] {
  const width = String(code.endLine).length;
  const language = sanitizeTerminalText(code.language);
  const paint = highlighter(pc, language);
  const lines = [pc.cyan(`${sanitizeTerminalText(code.path)}:${code.startLine}-${code.endLine}`) + pc.dim(` (${language})`)];
  for (const [i, raw] of sanitizeTerminalText(code.text).split('\n').entries()) {
    const text = expandTabs(raw);
    const gutter = pc.dim(`${String(code.startLine + i).padStart(width)} │`);
    lines.push(text === '' ? gutter : `${gutter} ${paint(text)}`);
  }
  if (code.truncated) lines.push(pc.dim(`${' '.repeat(width)} │ … (truncated)`));
  return lines;
}
