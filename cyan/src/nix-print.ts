// nix-print.ts — printing helpers shared by every merger so merged output is nixfmt-clean.
//
// nixfmt (1.x) lays a function head out on one line only when it has at most two named
// arguments, no `?` defaults and fits in the print width; otherwise one argument per line
// with a trailing comma (`...` last, without one). A merger that always printed
// `{ a, b, c }:` produced files that failed the consumer's own treefmt hook on the first
// commit. These helpers print the shapes nixfmt itself would.

export const PRINT_WIDTH = 100;

/** Code-unit comparison. `localeCompare` is ICU/locale dependent, so output would differ per machine. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Union of ordered lists, highest layer first: the highest layer's order is kept and items
 * only a lower layer has are appended (in that lower layer's order, nearest layer first).
 * `layers` is lowest → highest, matching the resolver's sorted input.
 */
export function orderedUnion<T>(layers: readonly (readonly T[])[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (let i = layers.length - 1; i >= 0; i--) {
    for (const item of layers[i]) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/** `{ a, b }:` or the expanded multi-line form, exactly as nixfmt prints it. `args` are whole argument texts. */
export function printFunctionHead(args: readonly string[], hasEllipsis: boolean): string[] {
  const items = hasEllipsis ? [...args, '...'] : [...args];
  if (items.length === 0) return ['{ }:'];
  const oneLine = `{ ${items.join(', ')} }:`;
  const expanded = args.length >= 3 || args.some((arg) => arg.includes('?')) || oneLine.length > PRINT_WIDTH;
  if (!expanded) return [oneLine];
  const lines = ['{'];
  items.forEach((item, index) => {
    const last = index === items.length - 1;
    lines.push(`  ${item}${item === '...' || (last && hasEllipsis) ? '' : ','}`);
  });
  lines.push('}:');
  return lines;
}

/**
 * `<indent><lead> <a> <op> <b>;` on one line when it fits, otherwise the nixfmt operator
 * layout: lead on its own line, then one operand per line with the operator leading.
 * `trail` is appended to the last operand (`;`, or empty for a bare expression).
 */
export function printOperatorChain(
  indent: string,
  lead: string,
  operands: readonly string[],
  operator: string,
  trail: string,
): string[] {
  const flat = `${indent}${lead ? `${lead} ` : ''}${operands.join(` ${operator} `)}${trail}`;
  if (operands.length <= 1 || flat.length <= PRINT_WIDTH) return [flat];
  const lines: string[] = [];
  let operandIndent = indent;
  if (lead) {
    lines.push(`${indent}${lead}`);
    operandIndent = `${indent}  `;
  }
  operands.forEach((operand, index) => {
    const prefix = index === 0 ? '' : `${operator} `;
    const suffix = index === operands.length - 1 ? trail : '';
    lines.push(`${operandIndent}${prefix}${operand}${suffix}`);
  });
  return lines;
}

/** Collapses whitespace runs to one space, leaving the inside of `"..."` and `''...''` strings untouched. */
export function collapseArgWhitespace(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "'" && source[i + 1] === "'") {
      let j = i + 2;
      while (j < source.length) {
        if (source[j] === "'" && source[j + 1] === "'") {
          if (source[j + 2] === "'" || source[j + 2] === '$' || source[j + 2] === '\\') j += 3;
          else break;
        } else j += 1;
      }
      out += source.slice(i, j + 2);
      i = j + 2;
    } else if (/\s/.test(ch)) {
      while (i < source.length && /\s/.test(source[i])) i += 1;
      out += ' ';
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}
