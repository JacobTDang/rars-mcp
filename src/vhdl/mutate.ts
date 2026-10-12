// A literal substitution; occurrence picks one match, counting from 1, and every match is replaced without it.
export interface MutationSpec {
  name?: string | undefined;
  find: string;
  replace: string;
  occurrence?: number | undefined;
}

// A mutated copy of a design file and the line its change starts on.
export interface Mutant {
  name: string;
  line: number;
  source: string;
}

interface Site {
  index: number;
  length: number;
  replacement: string;
  label: string;
}

// Each operator becomes its opposite: a sum a difference, a comparison its negation.
const SWAPS = new Map([['+', '-'], ['-', '+'], ['=', '/='], ['/=', '='], ['<', '>='], ['>=', '<'], ['<=', '>'], ['>', '<=']]);
// Words an expression can follow. After them an apostrophe opens a character literal, as in when '1',
// rather than an attribute, as in clk'event, and + or - is a sign rather than an operator.
const BEFORE_EXPRESSION = new Set([
  'abs', 'and', 'assert', 'case', 'downto', 'else', 'elsif', 'if', 'in', 'inertial', 'mod', 'nand', 'nor', 'not', 'or',
  'range', 'reject', 'rem', 'return', 'rol', 'ror', 'select', 'sla', 'sll', 'sra', 'srl', 'then', 'to', 'transport',
  'until', 'when', 'while', 'with', 'xnor', 'xor',
]);
// Declarations, including port and generic clauses and maps, are left alone: changing a width or an
// initial value tests the elaborator more than the testbench.
const DECLARATIONS = new Set(['alias', 'attribute', 'constant', 'file', 'generic', 'port', 'shared', 'signal', 'subtype', 'type', 'variable']);
// A condition runs from one of these words to one of the next set, or to the end of the statement.
// Inside it <= compares, and '0' or '1' is a value compared rather than assigned.
const CONDITION_STARTS = new Set(['assert', 'elsif', 'if', 'return', 'until', 'when', 'while', 'with']);
const CONDITION_ENDS = new Set(['else', 'for', 'generate', 'is', 'loop', 'report', 'select', 'severity', 'then']);

const SKIPPED = /\s+|--[^\n]*|\/\*[\s\S]*?\*\//y;
const STRING = /"(?:[^"\n]|"")*"/y;
const WORD = /[A-Za-z]\w*|\\[^\\\n]*\\/y;
// Includes based literals and exponents, so the sign in 1.0E-3 is not an operator.
const NUMBER = /\d[\d_]*(?:#[\w.]*#|\.[\d_]+)?(?:[eE][+-]?\d[\d_]*)?/y;
const OPERATOR = /\?\/=|\?[<>]=?|\?[=?]|\*\*|=>|<=|>=|\/=|:=|<>|<<|>>|[^\s\w"'\\]/y;
const SPACES = /\s*/y;

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function replaceAt(source: string, index: number, length: number, replacement: string): string {
  return source.slice(0, index) + replacement + source.slice(index + length);
}

export function applyMutation(source: string, spec: MutationSpec): Mutant {
  const name = spec.name ?? `${spec.find} -> ${spec.replace}${spec.occurrence === undefined ? '' : ` (occurrence ${spec.occurrence})`}`;
  if (spec.find === spec.replace) throw new Error(`Mutation "${name}" changes nothing`);
  const matches: number[] = [];
  for (let index = source.indexOf(spec.find); index !== -1; index = source.indexOf(spec.find, index + spec.find.length)) {
    matches.push(index);
  }
  if (matches.length === 0) throw new Error(`Mutation "${name}": "${spec.find}" is not in the file`);
  if (spec.occurrence === undefined) {
    return { name, line: lineAt(source, matches[0]!), source: source.split(spec.find).join(spec.replace) };
  }
  const index = matches[spec.occurrence - 1];
  if (index === undefined) {
    throw new Error(`Mutation "${name}": "${spec.find}" occurs ${matches.length} ${matches.length === 1 ? 'time' : 'times'}, `
      + `so there is no occurrence ${spec.occurrence}`);
  }
  return { name, line: lineAt(source, index), source: replaceAt(source, index, spec.find.length, spec.replace) };
}

// Scans the VHDL tokens for operators to swap, '0' and '1' assigned to something, and not to remove.
function findSites(source: string): Site[] {
  const sites: Site[] = [];
  let depth = 0;
  let condition = false;
  let assigned = false;
  let declaration = false;
  // The kind of the last token: an apostrophe after a name or ")" starts an attribute.
  let previous: 'name' | 'literal' | 'other' = 'other';
  let index = 0;
  const match = (pattern: RegExp): string | undefined => {
    pattern.lastIndex = index;
    return pattern.exec(source)?.[0];
  };

  while (index < source.length) {
    const skipped = match(SKIPPED);
    if (skipped !== undefined) {
      index += skipped.length;
      continue;
    }
    if (source[index] === "'") {
      const literal: string | undefined = previous !== 'name' && source[index + 2] === "'" ? source.slice(index, index + 3) : undefined;
      if ((literal === "'0'" || literal === "'1'") && assigned && !condition && !declaration) {
        const replacement = literal === "'0'" ? "'1'" : "'0'";
        sites.push({ index, length: 3, replacement, label: `${literal} -> ${replacement}` });
      }
      previous = literal === undefined ? 'other' : 'literal';
      index += literal?.length ?? 1;
      continue;
    }
    const literal = match(STRING) ?? match(NUMBER);
    if (literal !== undefined) {
      previous = 'literal';
      index += literal.length;
      continue;
    }
    const word = match(WORD);
    if (word !== undefined) {
      const lower = word.toLowerCase();
      if (depth === 0 && DECLARATIONS.has(lower)) declaration = true;
      if (depth === 0 && CONDITION_STARTS.has(lower)) condition = true;
      if (depth === 0 && CONDITION_ENDS.has(lower)) condition = false;
      if (!declaration && (lower === 'and' || lower === 'or')) {
        const opposite = lower === 'and' ? 'or' : 'and';
        const replacement = word === word.toUpperCase() ? opposite.toUpperCase() : opposite;
        sites.push({ index, length: word.length, replacement, label: `${word} -> ${replacement}` });
      } else if (!declaration && lower === 'not') {
        SPACES.lastIndex = index + word.length;
        sites.push({ index, length: word.length + SPACES.exec(source)![0].length, replacement: '', label: 'remove not' });
      }
      previous = BEFORE_EXPRESSION.has(lower) ? 'other' : 'name';
      index += word.length;
      continue;
    }

    const operator = match(OPERATOR) ?? source[index]!;
    if (operator === '(') depth += 1;
    else if (operator === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && operator === ';') [condition, assigned, declaration] = [false, false, false];
    else if (depth === 0 && (operator === ',' || operator === '=>')) condition = false;
    else if (depth === 0 && operator === ':=') assigned = true;
    // A sign is left alone: numeric_std has unary - but no unary + for signed.
    const sign = (operator === '+' || operator === '-') && previous === 'other';
    // The first <= of a statement outside a condition assigns; any other compares.
    if (operator === '<=' && depth === 0 && !condition && !assigned) {
      assigned = true;
    } else if (!declaration && !sign && SWAPS.has(operator)) {
      const replacement = SWAPS.get(operator)!;
      sites.push({ index, length: operator.length, replacement, label: `${operator} -> ${replacement}` });
    }
    previous = operator === ')' ? 'name' : 'other';
    index += operator.length;
  }
  return sites;
}

// One mutation per site, in file order; only the first limit are built, and found counts them all.
export function discoverMutations(source: string, limit = Infinity): { mutants: Mutant[]; found: number } {
  const sites = findSites(source);
  const mutants = sites.slice(0, limit).map(({ index, length, replacement, label }) => {
    const line = lineAt(source, index);
    return { name: `line ${line}: ${label}`, line, source: replaceAt(source, index, length, replacement) };
  });
  return { mutants, found: sites.length };
}
