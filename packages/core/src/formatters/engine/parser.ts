import {
  ExpressionNode,
  OperandNode,
  TemplateNode,
  ToolNode,
  rawText,
} from './ast.js';
import { canonicaliseField, nearestName, suggestField } from './fields.js';
import { allModifierNames, prefixOperators } from './modifiers.js';
import { comparatorNames } from './comparators.js';

/**
 * Single-pass template parser. Linear in template length with a bounded stack,
 * so no input can make it backtrack.
 *
 * Governing rule: a parse failure inside `{...}` emits that span as literal
 * text and resumes one character past the brace, so a nested `{` can still
 * open a valid expression.
 */

const comparators = (): readonly string[] => comparatorNames;

/** Longest first, so `sbytes10` wins over `sbytes`. */
const plainModifiers = (): readonly string[] => PLAIN_MODIFIERS;
const PLAIN_MODIFIERS = [...allModifierNames]
  .map((name) => name.toLowerCase())
  .sort((a, b) => b.length - a.length);

/** Longest first, so `>=` wins over `>`. */
const PREFIX_OPERATORS: readonly string[] = prefixOperators;

/**
 * Argument shape per modifier. These decide whether an expression parses at all,
 * so they are not interchangeable: `remove()` is valid, `join()` is not.
 */
type CallArgumentShape =
  | 'quoted'
  | 'quotedPair'
  | 'replaceArgs'
  | 'digits'
  | 'digitsOrPair'
  | 'loose';

const CALL_MODIFIERS: readonly (readonly [string, CallArgumentShape])[] = [
  ['replace', 'replaceArgs'],
  ['remove', 'loose'],
  ['join', 'quoted'],
  ['truncate', 'digits'],
  ['slice', 'digitsOrPair'],
  ['time', 'quoted'],
  ['date', 'quoted'],
  ['default', 'quoted'],
  ['in', 'loose'],
  ['translate', 'quotedPair'],
];

const LOOKS_LIKE_EXPRESSION =
  /^\s*[A-Za-z_][A-Za-z0-9_]*\s*\.\s*[A-Za-z_][A-Za-z0-9_]*/;

/** Caps so a pathological template cannot produce unbounded diagnostic work. */
const MAX_DIAGNOSTICS = 25;
const MAX_SPAN_SCAN = 4000;
const MAX_BRANCH_DEPTH = 5;

/**
 * Recovery resumes one character past a failed `{`, so text nested inside it is
 * re-scanned as though it were top level.
 */
const NESTED_SAFE_CATEGORIES: ReadonlySet<DiagnosticCategory> = new Set([
  'unknown-field',
  'unknown-modifier',
  'modifier-arguments',
]);

export interface ParseResult {
  nodes: TemplateNode[];
  /** non-fatal notes for validation surfaces; rendering ignores these */
  diagnostics: Diagnostic[];
}

export type DiagnosticCategory =
  | 'unknown-field'
  | 'unknown-modifier'
  | 'modifier-arguments'
  | 'conditional'
  | 'unterminated'
  | 'unterminated-group'
  | 'unparseable';

export interface Diagnostic {
  index: number;
  message: string;
  source: string;
  category: DiagnosticCategory;
  suggestion?: string;
}

/**
 * Advisory only. Saved templates may contain spans that have always rendered as
 * literal text, so a diagnostic is not grounds for rejecting a config.
 */
export function validateTemplate(template: string): Diagnostic[] {
  const { nodes, diagnostics } = parseTemplate(template);
  const all = [...diagnostics, ...branchDiagnostics(nodes, template)];

  const seen = new Set<string>();
  return all.filter((d) => {
    const key = `${d.index}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Conditional branches are stored as raw strings and only compiled at render
 * time, so nothing else ever validates them. Walked here rather than in
 * `parseTemplate` to keep this off the render path.
 */
function branchDiagnostics(
  nodes: TemplateNode[],
  template: string,
  anchor?: number,
  depth = 0
): Diagnostic[] {
  if (depth > MAX_BRANCH_DEPTH) return [];
  const out: Diagnostic[] = [];
  // nodes come out in document order, so a moving search survives repeats
  let cursor = 0;
  for (const node of nodes) {
    if (node.kind === 'group') {
      out.push(...branchDiagnostics(node.nodes, template, anchor, depth + 1));
      continue;
    }
    if (node.kind !== 'expression') continue;

    let index = anchor ?? 0;
    if (anchor === undefined) {
      const found = template.indexOf(node.source, cursor);
      if (found >= 0) {
        index = found;
        cursor = found + node.source.length;
      }
    }

    if (!node.check) continue;
    for (const branch of [
      node.check.trueTemplate,
      node.check.falseTemplate,
      node.check.absentTemplate,
    ]) {
      if (!branch) continue;
      const inner = parseTemplate(branch);
      out.push(
        ...inner.diagnostics.map((d) => ({
          ...d,
          index,
          message: `inside conditional branch: ${d.message}`,
        })),
        ...branchDiagnostics(inner.nodes, branch, index, depth + 1)
      );
    }
  }
  return out;
}

class Scanner {
  constructor(
    private readonly input: string,
    public pos = 0
  ) {}

  get atEnd(): boolean {
    return this.pos >= this.input.length;
  }

  peek(offset = 0): string | undefined {
    return this.input[this.pos + offset];
  }

  /** Case-insensitive literal match, consuming on success. */
  eat(literal: string): boolean {
    const slice = this.input.substr(this.pos, literal.length);
    if (slice.toLowerCase() !== literal.toLowerCase()) return false;
    this.pos += literal.length;
    return true;
  }

  startsWith(literal: string): boolean {
    return (
      this.input.substr(this.pos, literal.length).toLowerCase() ===
      literal.toLowerCase()
    );
  }

  slice(from: number, to = this.pos): string {
    return this.input.slice(from, to);
  }
}

/** Terminates a section/property name, so no lookahead is needed. */
function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

/** Unquoted prefix argument: anything but `}`, `[`, `]`, stopping at `::`. */
function scanPrefixArgument(scanner: Scanner): void {
  while (!scanner.atEnd) {
    const char = scanner.peek()!;
    if (char === '}' || char === '[' || char === ']') break;
    if (char === ':' && scanner.peek(1) === ':') break;
    scanner.pos += 1;
  }
}

/**
 * A quote only closes the argument when followed by `,`, `)` or whitespace, so
 * an apostrophe mid-word stays literal: `replace("Director's Cut", 'x')`.
 */
function scanQuotedArgument(scanner: Scanner): boolean {
  const quote = scanner.peek();
  if (quote !== "'" && quote !== '"') return false;
  scanner.pos += 1;

  while (!scanner.atEnd) {
    if (scanner.peek() === quote) {
      const after = scanner.peek(1);
      if (
        after === undefined ||
        after === ',' ||
        after === ')' ||
        /\s/.test(after)
      ) {
        scanner.pos += 1;
        return true;
      }
    }
    scanner.pos += 1;
  }
  return false;
}

function scanDigits(scanner: Scanner): boolean {
  const start = scanner.pos;
  while (scanner.peek() !== undefined && /\d/.test(scanner.peek()!)) {
    scanner.pos += 1;
  }
  return scanner.pos > start;
}

function skipSpaces(scanner: Scanner): void {
  while (scanner.peek() !== undefined && /\s/.test(scanner.peek()!)) {
    scanner.pos += 1;
  }
}

/**
 * The argument may itself contain parentheses, as in `remove('DV (Disk)')`, so
 * it ends at the last `)` in range rather than the first.
 */
function scanLooseArgument(scanner: Scanner): boolean {
  let lastParen = -1;
  while (!scanner.atEnd) {
    const char = scanner.peek()!;
    if (char === '}' || char === '[' || char === ']') break;
    if (char === ':' && scanner.peek(1) === ':') break;
    if (char === ')') lastParen = scanner.pos;
    scanner.pos += 1;
  }
  if (lastParen === -1) return false;
  scanner.pos = lastParen;
  return true;
}

function scanCallArguments(
  scanner: Scanner,
  shape: CallArgumentShape
): boolean {
  if (!scanner.eat('(')) return false;

  switch (shape) {
    case 'quoted':
      if (!scanQuotedArgument(scanner)) return false;
      break;
    case 'quotedPair':
      if (!scanQuotedArgument(scanner)) return false;
      skipSpaces(scanner);
      if (!scanner.eat(',')) return false;
      skipSpaces(scanner);
      if (!scanQuotedArgument(scanner)) return false;
      break;
    case 'replaceArgs':
      // the search key may be a {variable} rather than a quoted string
      if (scanner.peek() === '{') {
        while (!scanner.atEnd && scanner.peek() !== '}') scanner.pos += 1;
        if (!scanner.eat('}')) return false;
      } else if (!scanQuotedArgument(scanner)) {
        return false;
      }
      skipSpaces(scanner);
      if (!scanner.eat(',')) return false;
      skipSpaces(scanner);
      if (!scanQuotedArgument(scanner)) return false;
      break;
    case 'digits':
      if (!scanDigits(scanner)) return false;
      break;
    case 'digitsOrPair':
      skipSpaces(scanner);
      if (!scanDigits(scanner)) return false;
      skipSpaces(scanner);
      if (scanner.eat(',')) {
        skipSpaces(scanner);
        if (!scanDigits(scanner)) return false;
        skipSpaces(scanner);
      }
      break;
    case 'loose':
      // consumes up to its own closing paren, so return directly
      return scanLooseArgument(scanner) && scanner.eat(')');
  }

  return scanner.eat(')');
}

/** One `::modifier`. Returns the modifier's source text, or undefined. */
function parseModifier(scanner: Scanner): string | undefined {
  const start = scanner.pos;

  for (const [name, shape] of CALL_MODIFIERS) {
    if (!scanner.startsWith(`${name}(`)) continue;
    scanner.pos += name.length;
    if (scanCallArguments(scanner, shape)) return scanner.slice(start);
    // wrong shape is not a match; a prefix or plain modifier may still fit
    scanner.pos = start;
    break;
  }

  for (const operator of PREFIX_OPERATORS) {
    if (scanner.startsWith(operator)) {
      scanner.pos += operator.length;
      scanPrefixArgument(scanner);
      return scanner.slice(start);
    }
  }

  for (const name of plainModifiers()) {
    if (!scanner.startsWith(name)) continue;
    const after = scanner.peek(name.length);
    // must end at a boundary, so `upper` does not match `uppercase`
    if (isIdentifierChar(after)) continue;
    scanner.pos += name.length;
    return scanner.slice(start);
  }

  scanner.pos = start;
  return undefined;
}

/** `section.property`, case preserved. */
function parseOperandHead(
  scanner: Scanner
): { section: string; property: string } | undefined {
  const start = scanner.pos;
  while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
  let section = scanner.slice(start);
  if (!section || scanner.peek() !== '.') {
    scanner.pos = start;
    return undefined;
  }
  scanner.pos += 1;

  const propertyStart = scanner.pos;
  while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
  let property = scanner.slice(propertyStart);
  if (!property) {
    scanner.pos = start;
    return undefined;
  }

  // an unknown property is not an expression at all, so it stays literal
  const canonical = canonicaliseField(section, property);
  if (!canonical) {
    scanner.pos = start;
    return undefined;
  }
  // stored canonically so lookup does not depend on how it was typed
  [section, property] = canonical;

  return { section, property };
}

function parseOperand(scanner: Scanner): OperandNode | undefined {
  // a quoted literal stands in for a field
  let head: { section: string; property: string; literal?: string } | undefined;
  if (scanner.peek() === "'" || scanner.peek() === '"') {
    const quote = scanner.peek()!;
    const start = scanner.pos;
    scanner.pos += 1;
    const from = scanner.pos;
    while (!scanner.atEnd && scanner.peek() !== quote) scanner.pos += 1;
    if (scanner.atEnd) {
      scanner.pos = start;
      return undefined;
    }
    const literal = scanner.slice(from);
    scanner.pos += 1;
    head = { section: '', property: '', literal };
  } else {
    head = parseOperandHead(scanner);
  }
  if (!head) return undefined;

  const modifiers: string[] = [];
  while (scanner.startsWith('::')) {
    // a comparator ends this operand rather than extending it
    const save = scanner.pos;
    scanner.pos += 2;
    if (comparators().some((c) => scanner.startsWith(`${c}::`))) {
      scanner.pos = save;
      break;
    }
    const modifier = parseModifier(scanner);
    if (modifier === undefined) {
      scanner.pos = save;
      break;
    }
    modifiers.push(modifier);
  }

  return { ...head, modifiers };
}

/** `["true"||"false"]`, with an optional third branch for absent. */
/** Where a conditional stopped parsing. */
type CheckFailure =
  | 'no-open'
  | 'true-branch'
  | 'missing-or'
  | 'false-branch'
  | 'absent-branch'
  | 'missing-close';

function parseCheck(
  scanner: Scanner,
  onFail?: (reason: CheckFailure, at: number) => void
):
  | { trueTemplate: string; falseTemplate: string; absentTemplate?: string }
  | undefined {
  const start = scanner.pos;
  const fail = (reason: CheckFailure) => {
    onFail?.(reason, scanner.pos);
    scanner.pos = start;
    return undefined;
  };

  if (!scanner.eat('[')) return fail('no-open');

  /**
   * Brace depth is tracked so a quote inside a nested expression does not close
   * the branch, which is what allows conditionals to nest.
   */
  const branch = (): string | undefined => {
    if (!scanner.eat('"')) return undefined;
    let text = '';
    let depth = 0;
    while (!scanner.atEnd) {
      const char = scanner.peek()!;
      if (char === '\\' && scanner.peek(1) === '"') {
        text += '"';
        scanner.pos += 2;
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}') depth = Math.max(0, depth - 1);
      else if (char === '"' && depth === 0) {
        scanner.pos += 1;
        return text;
      }
      text += char;
      scanner.pos += 1;
    }
    return undefined;
  };

  const trueTemplate = branch();
  if (trueTemplate === undefined) return fail('true-branch');
  if (!scanner.eat('||')) return fail('missing-or');
  const falseTemplate = branch();
  if (falseTemplate === undefined) return fail('false-branch');

  // third branch distinguishes absent from false
  let absentTemplate: string | undefined;
  if (scanner.startsWith('||')) {
    scanner.pos += 2;
    absentTemplate = branch();
    if (absentTemplate === undefined) return fail('absent-branch');
  }

  if (!scanner.eat(']')) return fail('missing-close');
  return {
    trueTemplate,
    falseTemplate,
    ...(absentTemplate !== undefined ? { absentTemplate } : {}),
  };
}

/** Finds the matching `?}`, allowing groups to nest. */
function parseGroupBody(scanner: Scanner): string | undefined {
  const start = scanner.pos;
  if (!scanner.eat('{?')) return undefined;

  const from = scanner.pos;
  let depth = 1;
  while (!scanner.atEnd) {
    if (scanner.startsWith('{?')) {
      depth += 1;
      scanner.pos += 2;
      continue;
    }
    if (scanner.startsWith('?}')) {
      depth -= 1;
      if (depth === 0) {
        const body = scanner.slice(from);
        scanner.pos += 2;
        return body;
      }
      scanner.pos += 2;
      continue;
    }
    scanner.pos += 1;
  }

  scanner.pos = start;
  return undefined;
}

/** `{tools.newLine}` / `{tools.removeLine}`: layout directives, not values. */
function parseTool(scanner: Scanner): ToolNode | undefined {
  const start = scanner.pos;
  for (const tool of ['newLine', 'removeLine'] as const) {
    if (scanner.eat(`{tools.${tool}}`)) return { kind: 'tool', tool };
    scanner.pos = start;
  }
  return undefined;
}

/** Attempts one `{...}` at the scanner's position. */
function parseExpression(scanner: Scanner): ExpressionNode | undefined {
  const start = scanner.pos;
  const fail = () => {
    scanner.pos = start;
    return undefined;
  };

  if (!scanner.eat('{')) return fail();
  skipSpaces(scanner);

  const operands: OperandNode[] = [];
  const found: string[] = [];

  const first = parseOperand(scanner);
  if (!first) return fail();
  operands.push(first);

  while (scanner.startsWith('::')) {
    const save = scanner.pos;
    scanner.pos += 2;
    const comparator = comparators().find((name: string) =>
      scanner.startsWith(`${name}::`)
    );
    if (!comparator) {
      scanner.pos = save;
      break;
    }
    scanner.pos += comparator.length + 2;
    const operand = parseOperand(scanner);
    if (!operand) return fail();
    found.push(comparator.toLowerCase());
    operands.push(operand);
  }

  const check = scanner.peek() === '[' ? parseCheck(scanner) : undefined;
  skipSpaces(scanner);
  if (!scanner.eat('}')) return fail();

  return {
    kind: 'expression',
    source: scanner.slice(start),
    operands,
    comparators: found,
    ...(check ? { check } : {}),
  };
}

/** Never throws; unparseable spans render verbatim and are reported in `diagnostics`. */
export function parseTemplate(template: string): ParseResult {
  const scanner = new Scanner(template);
  const nodes: TemplateNode[] = [];
  const diagnostics: Diagnostic[] = [];

  let literalStart = 0;
  /** End of the furthest span that has already failed; see NESTED_SAFE_CATEGORIES. */
  let recoveringUntil = 0;
  const flushLiteral = (end: number) => {
    if (end > literalStart)
      nodes.push(rawText(template.slice(literalStart, end)));
  };

  while (!scanner.atEnd) {
    if (scanner.peek() !== '{') {
      scanner.pos += 1;
      continue;
    }

    const braceIndex = scanner.pos;

    if (scanner.startsWith('{?')) {
      const body = parseGroupBody(scanner);
      if (body !== undefined) {
        flushLiteral(braceIndex);
        const inner = parseTemplate(body);
        // `parseGroupBody` eats `{?` before capturing the body, so body offset 0
        // sits two characters in; nested groups compose by each adding its own
        const offset = braceIndex + 2;
        diagnostics.push(
          ...inner.diagnostics.map((d) => ({ ...d, index: d.index + offset }))
        );
        nodes.push({ kind: 'group', nodes: inner.nodes });
        literalStart = scanner.pos;
        continue;
      }
      if (diagnostics.length < MAX_DIAGNOSTICS) {
        diagnostics.push({
          index: braceIndex,
          message: 'unterminated group: no matching `?}`',
          source: template.slice(braceIndex, braceIndex + 2),
          category: 'unterminated-group',
        });
      }
    }

    const node = parseTool(scanner) ?? parseExpression(scanner);

    if (!node) {
      const closing = template.indexOf('}', braceIndex);
      const inner =
        closing === -1 ? '' : template.slice(braceIndex + 1, closing);

      // Diagnosed over a brace-matched span, independently of the substitution
      // decision below. That decision governs rendered output and must not
      // change, so the two are deliberately kept apart.
      if (diagnostics.length < MAX_DIAGNOSTICS) {
        const diagnostic = diagnoseSpan(template, braceIndex);
        const nested = braceIndex < recoveringUntil;
        if (
          diagnostic &&
          (!nested || NESTED_SAFE_CATEGORIES.has(diagnostic.category))
        ) {
          diagnostics.push(diagnostic);
        }
      }
      recoveringUntil = Math.max(
        recoveringUntil,
        matchBrace(template, braceIndex).end
      );

      // only substitute when the text was clearly meant as an expression, so
      // prose containing a stray brace stays prose. a nested `{` may still open
      // a valid expression, so leave it alone
      if (!inner.includes('{') && LOOKS_LIKE_EXPRESSION.test(inner)) {
        flushLiteral(braceIndex);
        nodes.push({
          kind: 'raw',
          text: `{invalid_expression(${inner.trim()})}`,
        });
        scanner.pos = closing + 1;
        literalStart = scanner.pos;
        continue;
      }
      scanner.pos = braceIndex + 1;
      continue;
    }

    flushLiteral(braceIndex);
    nodes.push(node);
    literalStart = scanner.pos;
  }

  flushLiteral(template.length);
  return { nodes, diagnostics };
}

// --------------------------------------------------------------- diagnostics

/** Example argument list per shape, so the message can show the fix. */
const ARGUMENT_EXAMPLES: Record<CallArgumentShape, string> = {
  quoted: "('text')",
  quotedPair: "('from', 'to')",
  replaceArgs: "('find', 'replaceWith')",
  digits: '(3)',
  digitsOrPair: '(0, 3)',
  loose: "('a', 'b')",
};

/** Extent of the `{...}` opening at `braceIndex`, matching nested braces. */
function matchBrace(
  template: string,
  braceIndex: number
): { end: number; terminated: boolean } {
  let depth = 0;
  const limit = Math.min(template.length, braceIndex + MAX_SPAN_SCAN);
  for (let i = braceIndex; i < limit; i++) {
    const char = template[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { end: i, terminated: true };
    }
  }
  return { end: limit, terminated: false };
}

/** Every modifier name the grammar accepts, for near-miss suggestions. */
function knownModifierNames(): string[] {
  return [
    ...new Set([...plainModifiers(), ...CALL_MODIFIERS.map(([name]) => name)]),
  ];
}

function isKnownModifier(token: string): boolean {
  return knownModifierNames().includes(token.toLowerCase());
}

/**
 * Classifies an already-failed `{...}` span. Returns undefined when the span was
 * never expression-like, so prose is left alone.
 */
function diagnoseSpan(
  template: string,
  braceIndex: number
): Diagnostic | undefined {
  const { end, terminated } = matchBrace(template, braceIndex);
  const source = template.slice(braceIndex, terminated ? end + 1 : end);
  const inner = terminated ? source.slice(1, -1) : source.slice(1);
  if (!LOOKS_LIKE_EXPRESSION.test(inner)) return undefined;

  const at = (
    category: DiagnosticCategory,
    message: string,
    suggestion?: string
  ): Diagnostic => ({
    index: braceIndex,
    message,
    source,
    category,
    ...(suggestion ? { suggestion } : {}),
  });

  /**
   * `join` and `time` sit in both tables, so the call shape is checked first.
   */
  const badArguments = (token: string): Diagnostic => {
    const lower = token.toLowerCase();
    const call = CALL_MODIFIERS.find(([name]) => name === lower);
    return at(
      'modifier-arguments',
      call
        ? `modifier \`${token}\` has invalid arguments; expected \`${lower}${ARGUMENT_EXAMPLES[call[1]]}\``
        : `modifier \`${token}\` takes no arguments`
    );
  };

  const scanner = new Scanner(source);
  scanner.eat('{');
  skipSpaces(scanner);

  /** An unknown field is the most common authoring error by far. */
  const checkHead = (): Diagnostic | undefined => {
    const headStart = scanner.pos;
    while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
    const section = scanner.slice(headStart);
    if (!section || scanner.peek() !== '.') {
      // quoted literal or malformed head; the modifier pass may still explain it
      scanner.pos = headStart;
      return undefined;
    }
    scanner.pos += 1;
    const propertyStart = scanner.pos;
    while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
    const property = scanner.slice(propertyStart);
    if (!property || canonicaliseField(section, property)) return undefined;

    const suggestions = suggestField(section, property);
    const hint = suggestions.length
      ? ` — did you mean \`${suggestions.join('` or `')}\`?`
      : '';
    return at(
      'unknown-field',
      `unknown field \`${section}.${property}\`${hint}`,
      suggestions[0]
    );
  };

  const checkModifiers = (): Diagnostic | undefined => {
    while (scanner.startsWith('::')) {
      const save = scanner.pos;
      scanner.pos += 2;
      // a comparator ends this operand rather than extending it
      if (comparators().some((c) => scanner.startsWith(`${c}::`))) {
        scanner.pos = save;
        return undefined;
      }
      const modifierStart = scanner.pos;
      if (parseModifier(scanner)) {
        // a plain modifier matches even when followed by `(`, leaving the
        // argument list dangling for `eat('}')` to choke on later
        if (scanner.peek() === '(') {
          return badArguments(scanner.slice(modifierStart));
        }
        continue;
      }

      // prefix operators consume almost anything, so are never the culprit
      if (PREFIX_OPERATORS.some((operator) => scanner.startsWith(operator))) {
        scanner.pos = save;
        return undefined;
      }

      const tokenStart = scanner.pos;
      while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
      const token = scanner.slice(tokenStart);
      if (!token) return undefined;
      if (isKnownModifier(token)) return badArguments(token);

      const close = nearestName(token.toLowerCase(), knownModifierNames());
      return at(
        'unknown-modifier',
        `unknown modifier \`${token}\`${close ? ` — did you mean \`${close}\`?` : ''}`
      );
    }
    return undefined;
  };

  // operands, separated by comparators, mirroring parseExpression
  for (;;) {
    const head = checkHead();
    if (head) return head;
    const modifier = checkModifiers();
    if (modifier) return modifier;

    if (!scanner.startsWith('::')) break;
    const save = scanner.pos;
    scanner.pos += 2;
    const comparator = comparators().find((c) => scanner.startsWith(`${c}::`));
    if (!comparator) {
      scanner.pos = save;
      break;
    }
    scanner.pos += comparator.length + 2;
  }

  // conditional, re-run the real grammar to find which part gave out
  if (scanner.peek() === '[') {
    let failure: { reason: CheckFailure; at: number } | undefined;
    parseCheck(scanner, (reason, position) => {
      failure ??= { reason, at: position };
    });
    if (failure) {
      const message = describeCheckFailure(source, failure.reason, failure.at);
      if (message) return at('conditional', message);
    }
  }

  if (!terminated) {
    return at('unterminated', 'unterminated expression: no closing `}`');
  }

  return at('unparseable', `unparseable expression: {${inner}}`);
}

/** Turns a `parseCheck` bail-out into something an author can act on. */
function describeCheckFailure(
  source: string,
  reason: CheckFailure,
  at: number
): string | undefined {
  if (reason === 'no-open') return undefined;
  if (reason === 'missing-close') {
    return 'conditional is missing its closing `]`';
  }
  if (reason === 'missing-or') {
    return 'conditional branches must be separated by `||`';
  }

  if (at >= source.length) {
    return 'unterminated conditional branch: a nested `{` is missing its `}`, or the branch is missing its closing `"`';
  }
  if (source[at] === '\\' && source[at + 1] === '"') {
    return 'conditional branch starts with an escaped quote `\\"` — escapes only apply one nesting level deeper';
  }
  return 'conditional branch must start with `"`';
}
