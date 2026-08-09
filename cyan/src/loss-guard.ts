// loss-guard.ts — the @3 loss-refusal invariant, shared by every merger.
//
// Until @3 only mergeFlake asserted that its inputs survived the merge; the other five
// mergers parsed into a model and pretty-printed it back, so anything the model did not
// happen to cover was dropped silently and the resolver still exited success. Two proven
// instances: a treefmt-formatted multi-line function head collapsed `nix/packages.nix` to
// `{ }:`, and `nix/shells.nix` lost its head, its `with env;` prelude and every
// `inherit shellHook;`. Both produced broken Nix and both reported success.
//
// The ruling for @3: EVERY merger refuses instead. If a function argument, a `with`
// prelude, an inherited identifier, or a binding/entry present in ANY input is absent
// from the output, the merge is not a merge — it is data loss — and the resolver must
// throw, naming exactly what went missing.
//
// Scope note. The invariant covers the *structure* of the inputs, not the right-hand side
// of every binding: last-write-wins on a value (`dotnet = dotnet-sdk;` superseded by
// `dotnet = dotnet-sdk_9;`) is the resolver's documented conflict semantics, and the
// binding `dotnet` itself still has to survive. What may never happen is a name — an
// argument, a prelude, an inherit, an attribute — vanishing without a word.

export interface MaterialInventory {
  args: Set<string>;
  bindings: Set<string>;
  inherited: Set<string>;
  withPreludes: Set<string>;
}

function spacesLike(value: string): string {
  return value.replace(/[^\n]/g, ' ');
}

/**
 * Replace comments and string literals with spaces, preserving newlines and character
 * offsets. Without this a commented-out `# foo = bar` or a shell fragment inside an
 * `entry = "..."` string would count as material the merger was asked to carry.
 */
export function maskNixTrivia(source: string): string {
  let output = '';
  let index = 0;

  while (index < source.length) {
    if (source[index] === '#') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      output += spacesLike(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);
      const stop = close === -1 ? source.length : close + 2;
      output += spacesLike(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (source[index] === '"') {
      let stop = index + 1;
      while (stop < source.length) {
        if (source[stop] === '\\') {
          stop += 2;
          continue;
        }
        stop++;
        if (source[stop - 1] === '"') break;
      }
      output += spacesLike(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (source.startsWith("''", index)) {
      const close = source.indexOf("''", index + 2);
      const stop = close === -1 ? source.length : close + 2;
      output += spacesLike(source.slice(index, stop));
      index = stop;
      continue;
    }

    output += source[index];
    index++;
  }
  return output;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;

  for (let index = 0; index < value.length; index++) {
    switch (value[index]) {
      case '{':
        braces++;
        break;
      case '}':
        braces--;
        break;
      case '[':
        brackets++;
        break;
      case ']':
        brackets--;
        break;
      case '(':
        parentheses++;
        break;
      case ')':
        parentheses--;
        break;
      case ',':
        if (braces === 0 && brackets === 0 && parentheses === 0) {
          parts.push(value.slice(start, index));
          start = index + 1;
        }
        break;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

export interface FunctionHeader {
  /** Argument names, in source order, without `...` and without defaults. */
  args: string[];
  /** Byte offset of the `:` that ends the header. */
  colonIndex: number;
  /** Byte offset of the `{` that opens the header. */
  openIndex: number;
  /** Byte offset of the `}` that closes the argument set. */
  closeIndex: number;
  /** True when the argument set ends in `...`. */
  hasEllipsis: boolean;
}

/**
 * Parse a Nix argument-set function header. Handles the single-line form
 * (`{ pkgs, env }:`) and the multi-line form treefmt produces once the head grows past
 * the print width — the shape that broke `parsePackages` and `parseShells`, both of
 * which only ever matched a head that fit on line 1.
 */
export function findFunctionHeader(source: string): FunctionHeader | null {
  const code = maskNixTrivia(source);
  const open = code.search(/\S/);
  if (open === -1 || code[open] !== '{') return null;

  let depth = 0;
  let close = -1;
  for (let index = open; index < code.length; index++) {
    if (code[index] === '{') depth++;
    if (code[index] === '}') {
      depth--;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close === -1) return null;

  let colon = close + 1;
  while (colon < code.length && /\s/.test(code[colon])) colon++;
  if (code[colon] !== ':') return null;

  const parts = splitTopLevel(code.slice(open + 1, close))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const args = parts
    .filter((part) => part !== '...')
    .map((part) => part.match(/^([a-zA-Z_][a-zA-Z0-9_'-]*)\b/)?.[1])
    .filter((part): part is string => part !== undefined);

  return {
    args: [...new Set(args)],
    colonIndex: colon,
    openIndex: open,
    closeIndex: close,
    hasEllipsis: parts.includes('...'),
  };
}

function withoutLeadingInheritSource(value: string): string {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith('(')) return trimmed;
  let depth = 0;
  for (let index = 0; index < trimmed.length; index++) {
    if (trimmed[index] === '(') depth++;
    if (trimmed[index] === ')') {
      depth--;
      if (depth === 0) return trimmed.slice(index + 1);
    }
  }
  return trimmed;
}

/** Inventory the names a merge is obliged to carry from an input into its output. */
export function inventoryMaterial(source: string): MaterialInventory {
  const code = maskNixTrivia(source);
  const header = findFunctionHeader(source);
  const args = new Set(header?.args ?? []);
  const bindings = new Set<string>();
  const inherited = new Set<string>();
  const withPreludes = new Set<string>();

  // Nix treats `hook = { enable = true; };` and `hook.enable = true;` as the same
  // attribute path, and the mergers legitimately re-render between those two forms.
  // Compare the path segments so a change of shape cannot read as a loss.
  for (const match of code.matchAll(
    /(?:^|[\n;{])\s*([a-zA-Z_][a-zA-Z0-9_'-]*(?:\.[a-zA-Z_][a-zA-Z0-9_'-]*)*)\s*=/gm,
  )) {
    for (const segment of match[1].split('.')) bindings.add(segment);
  }
  for (const match of code.matchAll(/\binherit\b([^;]*);/g)) {
    const body = withoutLeadingInheritSource(match[1]);
    for (const identifier of body.match(/[a-zA-Z_][a-zA-Z0-9_'-]*/g) ?? []) {
      inherited.add(identifier);
    }
  }
  for (const match of code.matchAll(/\bwith\s+([a-zA-Z_][a-zA-Z0-9_'-]*)\s*;/g)) {
    withPreludes.add(match[1]);
  }

  return { args, bindings, inherited, withPreludes };
}

interface LostUnit {
  kind: 'arg' | 'binding' | 'inherit' | 'with';
  value: string;
}

function describe(unit: LostUnit): string {
  switch (unit.kind) {
    case 'arg':
      return `function argument '${unit.value}'`;
    case 'binding':
      return `binding '${unit.value}'`;
    case 'inherit':
      return `inherited identifier '${unit.value}'`;
    case 'with':
      return `prelude 'with ${unit.value};'`;
  }
}

function lostUnits(inputs: string[], output: string): LostUnit[] {
  const actual = inventoryMaterial(output);
  const lost: LostUnit[] = [];
  const seen = new Set<string>();

  const check = (kind: LostUnit['kind'], value: string, present: Set<string>): void => {
    if (present.has(value)) return;
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    lost.push({ kind, value });
  };

  for (const input of inputs) {
    const expected = inventoryMaterial(input);
    for (const value of expected.args) check('arg', value, actual.args);
    for (const value of expected.withPreludes) check('with', value, actual.withPreludes);
    for (const value of expected.inherited) check('inherit', value, actual.inherited);
    // An inherited name may be re-rendered as an explicit binding and vice versa; accept
    // either, because both keep the name reachable in the merged expression.
    for (const value of expected.bindings) {
      if (actual.bindings.has(value) || actual.inherited.has(value)) continue;
      check('binding', value, actual.bindings);
    }
  }

  lost.sort((a, b) => (a.kind === b.kind ? a.value.localeCompare(b.value) : a.kind.localeCompare(b.kind)));
  return lost;
}

/**
 * Refuse a merge that dropped material. `file` names the dispatch path so the message
 * points at the file the caller must look at, not at the merger's internals.
 */
export function assertNoLoss(file: string, inputs: string[], output: string): void {
  const lost = lostUnits(inputs, output);
  if (lost.length === 0) return;

  const shown = lost.slice(0, 24).map(describe).join(', ');
  const remainder = lost.length > 24 ? `, plus ${lost.length - 24} more` : '';
  throw new Error(
    `Cannot merge ${file}: the merge lost ${shown}${remainder}. ` +
      `Every function argument, 'with' prelude, inherited identifier and binding present in an ` +
      `input must survive into the merged output; refusing rather than emitting a file that is ` +
      `missing them. This usually means the input uses a shape the ${file} merger does not model.`,
  );
}

export type MergeFn = (sortedFiles: { content: string; layer: number; template: string }[]) => string;

/**
 * Wrap a merger so its output is checked against every input before it is returned.
 * Applied to the whole dispatch table, so a merger added later cannot forget it.
 */
export function withLossGuard(file: string, merge: MergeFn): MergeFn {
  return (sortedFiles) => {
    const output = merge(sortedFiles);
    assertNoLoss(
      file,
      sortedFiles.map((f) => f.content),
      output,
    );
    return output;
  };
}
