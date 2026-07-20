import {
  ExpressionNode,
  OperandNode,
  TemplateNode,
  ToolNode,
  rawText,
} from './ast.js';
import { canonicaliseField } from './fields.js';
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

export interface ParseResult {
  nodes: TemplateNode[];
  /** non-fatal notes for validation surfaces; rendering ignores these */
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  index: number;
  message: string;
  source: string;
}

/**
 * Advisory only. Saved templates may contain spans that have always rendered as
 * literal text, so a diagnostic is not grounds for rejecting a config.
 */
export function validateTemplate(template: string): Diagnostic[] {
  return parseTemplate(template).diagnostics;
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
function parseCheck(
  scanner: Scanner
):
  | { trueTemplate: string; falseTemplate: string; absentTemplate?: string }
  | undefined {
  const start = scanner.pos;
  const fail = () => {
    scanner.pos = start;
    return undefined;
  };

  if (!scanner.eat('[')) return fail();

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
  if (trueTemplate === undefined) return fail();
  if (!scanner.eat('||')) return fail();
  const falseTemplate = branch();
  if (falseTemplate === undefined) return fail();

  // third branch distinguishes absent from false
  let absentTemplate: string | undefined;
  if (scanner.startsWith('||')) {
    scanner.pos += 2;
    absentTemplate = branch();
    if (absentTemplate === undefined) return fail();
  }

  if (!scanner.eat(']')) return fail();
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
        diagnostics.push(...inner.diagnostics);
        nodes.push({ kind: 'group', nodes: inner.nodes });
        literalStart = scanner.pos;
        continue;
      }
    }

    const node = parseTool(scanner) ?? parseExpression(scanner);

    if (!node) {
      // only complain when the text was clearly meant as an expression, so
      // prose containing a stray brace stays prose
      const closing = template.indexOf('}', braceIndex);
      const inner =
        closing === -1 ? '' : template.slice(braceIndex + 1, closing);
      // a nested `{` may still open a valid expression, so leave it alone
      if (
        !inner.includes('{') &&
        /^\s*[A-Za-z_][A-Za-z0-9_]*\s*\.\s*[A-Za-z_][A-Za-z0-9_]*/.test(inner)
      ) {
        diagnostics.push({
          index: braceIndex,
          message: `unparseable expression: {${inner}}`,
          source: template.slice(braceIndex, closing + 1),
        });
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
