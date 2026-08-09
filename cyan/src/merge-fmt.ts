// merge-fmt.ts — Parser, merger, and pretty-printer for nix/fmt.nix files.
//
// @3 rewrite. The @2 parser modelled exactly three program fields (`enable`,
// `extra_args`, and bare booleans) and matched the function head only when it fitted on
// line 1. Everything else — a real `prettier.excludes` list, a treefmt-broken multi-line
// head, an extra `let` binding — was dropped silently while the resolver still exited
// success. Worse, an unparseable head fell through to printing an empty skeleton
// (`:\nlet\n  fmt = {\n    projectRootFile = "";\n ...`), which is invalid Nix.
//
// This version:
//   * parses the head with the shared `findFunctionHeader` (single-line, multi-line,
//     defaulted and `...` forms),
//   * parses `fmt = { ... }` structurally instead of line-by-line,
//   * carries every value it cannot classify through verbatim — merge-precommit.ts's
//     `__raw__` passthrough convention, expressed here as a tagged union because a
//     program's field map has no fixed set of typed keys, and
//   * REFUSES with an error naming the file, the layer and what it could not parse
//     rather than emitting a file that is missing material.

import { findFunctionHeader, type FunctionHeader } from './loss-guard.ts';

const FILE = 'nix/fmt.nix';

// ─── Model ───────────────────────────────────────────────────────────────────

/**
 * A program field value. `bool` and `list` are modelled because they carry merge
 * semantics (true wins; lists re-indent). Everything else is `raw`: the original Nix
 * source text, reproduced verbatim so nothing the classifier does not understand can
 * vanish.
 */
type FieldValue =
  | { kind: 'bool'; value: boolean }
  | { kind: 'list'; items: string[] }
  | { kind: 'raw'; text: string };

interface ProgramModel {
  /**
   * Dotted attribute path within the program → value. `prettier = { enable = true; }`
   * and `prettier.enable = true;` both land as the path `enable`, which is how Nix
   * itself reads them.
   */
  fields: Map<string, FieldValue>;
  /** Set when the program's value is not an attribute set at all (`foo = someExpr;`). */
  raw?: string;
  comment?: string;
}

interface ParsedFmt {
  functionArgs: string;
  /** Raw value text of `projectRootFile`, e.g. `"flake.nix"`. */
  projectRootFile: string;
  projectRootFileComment?: string;
  programs: Map<string, ProgramModel>;
  hasPrograms: boolean;
  programsComment?: string;
  /** `let` bindings before `fmt = { ... }`, verbatim. */
  letPrefix: string;
  /** `let` bindings after `fmt = { ... }`, verbatim. */
  letSuffix: string;
  /** The expression after `in`. */
  tail: string;
  unknownKeys: string[];
}

// ─── Lexical helpers ─────────────────────────────────────────────────────────

function blank(value: string): string {
  return value.replace(/[^\n]/g, ' ');
}

/**
 * Offset-preserving mask used by every scanner below. Comments become spaces; string
 * literals become runs of `x`. This differs deliberately from loss-guard's
 * `maskNixTrivia`, which blanks strings too: the entry scanner has to see a string
 * literal as one opaque token rather than as whitespace, otherwise a list item like
 * `".claude/skills/vendor/**"` would be skipped as a gap between items.
 */
function mask(source: string): string {
  let out = '';
  let index = 0;

  while (index < source.length) {
    if (source[index] === '#') {
      const newline = source.indexOf('\n', index);
      const stop = newline === -1 ? source.length : newline;
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);
      const stop = close === -1 ? source.length : close + 2;
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (source.startsWith("''", index)) {
      const close = source.indexOf("''", index + 2);
      const stop = close === -1 ? source.length : close + 2;
      out += 'x'.repeat(stop - index);
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
      stop = Math.min(stop, source.length);
      out += 'x'.repeat(stop - index);
      index = stop;
      continue;
    }

    out += source[index];
    index++;
  }
  return out;
}

const CLOSERS: Record<string, string> = { '{': '}', '[': ']', '(': ')' };

/** Index of the bracket closing the one at `open`, in masked coordinates. */
function matchingIndex(code: string, open: number): number {
  const openChar = code[open];
  const closeChar = CLOSERS[openChar];
  if (!closeChar) return -1;

  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if (code[index] === openChar) depth++;
    else if (code[index] === closeChar) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Index of a bare keyword (`let`, `in`) at or after `from`, in masked coordinates. */
function findKeyword(code: string, from: number, word: string): number {
  const rest = code.slice(from);
  const match = new RegExp(`(?:^|[^a-zA-Z0-9_'.-])(${word})(?![a-zA-Z0-9_'-])`).exec(rest);
  if (!match) return -1;
  return from + match.index + match[0].lastIndexOf(word);
}

function splitTopLevelCommas(value: string): string[] {
  const code = mask(value);
  const parts: string[] = [];
  let start = 0;
  let depth = 0;

  for (let index = 0; index < code.length; index++) {
    const char = code[index];
    if (char === '{' || char === '[' || char === '(') depth++;
    else if (char === '}' || char === ']' || char === ')') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

/** The last non-empty line of a gap, when it is a comment. */
function trailingComment(gap: string): string | undefined {
  const lines = gap.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const trimmed = lines[index].trim();
    if (trimmed === '') continue;
    return trimmed.startsWith('#') ? trimmed : undefined;
  }
  return undefined;
}

/** Inner text of `value` when it is exactly one attribute set, else null. */
function attrsetBody(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return null;
  const close = matchingIndex(mask(trimmed), 0);
  return close === trimmed.length - 1 ? trimmed.slice(1, close) : null;
}

/** Inner text of `value` when it is exactly one list, else null. */
function listBody(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return null;
  const close = matchingIndex(mask(trimmed), 0);
  return close === trimmed.length - 1 ? trimmed.slice(1, close) : null;
}

function splitListItems(inner: string): string[] {
  const code = mask(inner);
  const items: string[] = [];
  let index = 0;

  while (index < code.length) {
    while (index < code.length && /\s/.test(code[index])) index++;
    if (index >= code.length) break;

    const start = index;
    let depth = 0;
    while (index < code.length) {
      const char = code[index];
      if (char === '{' || char === '[' || char === '(') depth++;
      else if (char === '}' || char === ']' || char === ')') depth--;
      else if (depth === 0 && /\s/.test(char)) break;
      index++;
    }
    items.push(inner.slice(start, index));
  }
  return items;
}

function trimBlankEdges(block: string): string {
  const lines = block.split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

function reindent(block: string, indent: string): string[] {
  const lines = block.split('\n');
  const widths = lines.filter((line) => line.trim() !== '').map((line) => line.match(/^\s*/)![0].length);
  const common = widths.length > 0 ? Math.min(...widths) : 0;
  return lines.map((line) => (line.trim() === '' ? '' : indent + line.slice(common)));
}

function compare(a: string, b: string): number {
  // Deliberately not `localeCompare`: collation is ICU/locale dependent, and a resolver
  // that ordered its output differently on two machines would not be deterministic.
  return a < b ? -1 : a > b ? 1 : 0;
}

function firstLine(value: string): string {
  return value.split('\n')[0].trim().slice(0, 60);
}

// ─── Attribute-set parsing ───────────────────────────────────────────────────

interface AttrEntry {
  path: string[];
  value: string;
  comment?: string;
}

/**
 * Split an attribute-set body into `path = value;` entries. Refuses on anything it does
 * not recognise instead of skipping it, because a skipped entry is exactly the silent
 * data loss @3 exists to stop.
 */
function splitAttrEntries(body: string, label: string, what: string): AttrEntry[] {
  const code = mask(body);
  const entries: AttrEntry[] = [];
  let index = 0;

  while (index < code.length) {
    const gapStart = index;
    while (index < code.length && /\s/.test(code[index])) index++;
    if (index >= code.length) break;

    const keyMatch = /^([a-zA-Z_][a-zA-Z0-9_'-]*(?:\s*\.\s*[a-zA-Z_][a-zA-Z0-9_'-]*)*)\s*=(?!=)/.exec(
      code.slice(index),
    );
    if (!keyMatch) {
      throw new Error(
        `${FILE}: could not parse ${what} — unrecognised entry starting "${firstLine(body.slice(index))}" in ${label}`,
      );
    }

    const path = keyMatch[1].split('.').map((segment) => segment.trim());
    let cursor = index + keyMatch[0].length;
    const valueStart = cursor;
    let depth = 0;
    while (cursor < code.length) {
      const char = code[cursor];
      if (char === '{' || char === '[' || char === '(') depth++;
      else if (char === '}' || char === ']' || char === ')') depth--;
      else if (char === ';' && depth === 0) break;
      cursor++;
    }
    if (cursor >= code.length) {
      throw new Error(
        `${FILE}: could not parse ${what} — binding "${path.join('.')}" is not terminated by ';' in ${label}`,
      );
    }

    entries.push({
      path,
      value: body.slice(valueStart, cursor).trim(),
      comment: trailingComment(body.slice(gapStart, index)),
    });
    index = cursor + 1;
  }

  return entries;
}

function classify(value: string): FieldValue {
  const trimmed = value.trim();
  if (trimmed === 'true') return { kind: 'bool', value: true };
  if (trimmed === 'false') return { kind: 'bool', value: false };

  const list = listBody(trimmed);
  if (list !== null) return { kind: 'list', items: splitListItems(list) };

  return { kind: 'raw', text: trimmed };
}

/**
 * Flatten a value into `fields` under `prefix`. Nested attribute sets become dotted
 * paths, which Nix treats as the same attribute path and which loss-guard compares
 * segment-wise, so re-rendering between the two shapes cannot read as a loss.
 */
function collectFields(
  prefix: string[],
  value: string,
  fields: Map<string, FieldValue>,
  label: string,
  what: string,
): void {
  const body = attrsetBody(value);
  if (body === null) {
    fields.set(prefix.join('.'), classify(value));
    return;
  }

  const inner = splitAttrEntries(body, label, what);
  if (inner.length === 0) {
    // An empty attrset has no segments to flatten; keep the binding itself.
    fields.set(prefix.join('.'), { kind: 'raw', text: '{ }' });
    return;
  }
  for (const entry of inner) {
    collectFields([...prefix, ...entry.path], entry.value, fields, label, what);
  }
}

function addProgramEntry(programs: Map<string, ProgramModel>, entry: AttrEntry, label: string): void {
  const what = "the 'programs' block";
  const [name, ...rest] = entry.path;

  let program = programs.get(name);
  if (!program) {
    program = { fields: new Map() };
    programs.set(name, program);
  }
  if (entry.comment) program.comment = entry.comment;

  if (rest.length > 0) {
    program.raw = undefined;
    collectFields(rest, entry.value, program.fields, label, what);
    return;
  }

  const body = attrsetBody(entry.value);
  if (body === null) {
    // `foo = someExpr;` — not an attrset. Carry it through verbatim.
    program.fields.clear();
    program.raw = entry.value.trim();
    return;
  }

  program.raw = undefined;
  for (const inner of splitAttrEntries(body, label, what)) {
    collectFields(inner.path, inner.value, program.fields, label, what);
  }
}

// ─── Parse ───────────────────────────────────────────────────────────────────

function canonicalArgs(content: string, header: FunctionHeader): string {
  // Rebuild from the header rather than re-matching `^\{([^}]+)\}$`, which cannot see a
  // multi-line head. Full argument text is kept so a default (`x ? y`) survives.
  const parts = splitTopLevelCommas(content.slice(header.openIndex + 1, header.closeIndex))
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '...');

  const named = [...parts].sort((a, b) => compare(argName(a), argName(b)));
  const all = header.hasEllipsis ? [...named, '...'] : named;
  return all.length === 0 ? '{ }' : `{ ${all.join(', ')} }`;
}

function argName(part: string): string {
  return part.match(/^([a-zA-Z_][a-zA-Z0-9_'-]*)/)?.[1] ?? part;
}

function parseFmt(content: string, label: string): ParsedFmt {
  const code = mask(content);

  const header = findFunctionHeader(content);
  if (!header) {
    throw new Error(
      `${FILE}: could not parse the function header — expected an argument set followed by ':' ` +
        `at the start of the file, in ${label}`,
    );
  }
  const functionArgs = canonicalArgs(content, header);

  const letIndex = findKeyword(code, header.colonIndex + 1, 'let');
  if (letIndex === -1) {
    throw new Error(`${FILE}: could not find the 'let' block after the function header in ${label}`);
  }
  const letBodyStart = letIndex + 'let'.length;

  const fmtMatch = /(?:^|[^a-zA-Z0-9_'.-])(fmt)\s*=\s*\{/.exec(code.slice(letBodyStart));
  if (!fmtMatch) {
    throw new Error(`${FILE}: could not find the 'fmt = { ... }' binding inside 'let' in ${label}`);
  }
  const fmtNameStart = letBodyStart + fmtMatch.index + fmtMatch[0].indexOf('fmt');
  const fmtOpen = letBodyStart + fmtMatch.index + fmtMatch[0].lastIndexOf('{');
  const fmtClose = matchingIndex(code, fmtOpen);
  if (fmtClose === -1) {
    throw new Error(`${FILE}: the 'fmt = { ... }' binding is never closed in ${label}`);
  }

  let afterFmt = fmtClose + 1;
  while (afterFmt < code.length && /\s/.test(code[afterFmt])) afterFmt++;
  if (code[afterFmt] === ';') afterFmt++;

  const inIndex = findKeyword(code, fmtClose + 1, 'in');
  if (inIndex === -1) {
    throw new Error(`${FILE}: could not find the 'in' that closes the 'let' block in ${label}`);
  }
  const tail = content.slice(inIndex + 'in'.length).trim();
  if (tail === '') {
    throw new Error(`${FILE}: the expression after 'in' is empty in ${label}`);
  }

  const letPrefix = trimBlankEdges(content.slice(letBodyStart, fmtNameStart));
  const letSuffix = trimBlankEdges(content.slice(afterFmt, inIndex));

  const entries = splitAttrEntries(content.slice(fmtOpen + 1, fmtClose), label, "the 'fmt = { ... }' block");

  let projectRootFile: string | null = null;
  let projectRootFileComment: string | undefined;
  let programsComment: string | undefined;
  let hasPrograms = false;
  const programs = new Map<string, ProgramModel>();
  const unknownKeys: string[] = [];

  for (const entry of entries) {
    const [head, ...rest] = entry.path;

    if (head === 'projectRootFile' && rest.length === 0) {
      projectRootFile = entry.value.trim();
      if (entry.comment) projectRootFileComment = entry.comment;
      continue;
    }

    if (head === 'programs') {
      hasPrograms = true;
      if (entry.comment) programsComment = entry.comment;

      if (rest.length > 0) {
        addProgramEntry(programs, { path: rest, value: entry.value }, label);
        continue;
      }

      const body = attrsetBody(entry.value);
      if (body === null) {
        throw new Error(`${FILE}: 'programs' is not an attribute set in ${label}`);
      }
      for (const inner of splitAttrEntries(body, label, "the 'programs' block")) {
        addProgramEntry(programs, inner, label);
      }
      continue;
    }

    unknownKeys.push(entry.path.join('.'));
  }

  if (projectRootFile === null) {
    // Never fall through to `projectRootFile = "";` — that byte string is the published
    // resolver's empty skeleton, the single worst thing this merger can emit.
    throw new Error(`${FILE}: no 'projectRootFile' binding inside 'fmt = { ... }' in ${label}`);
  }

  return {
    functionArgs,
    projectRootFile,
    projectRootFileComment,
    programs,
    hasPrograms,
    programsComment,
    letPrefix,
    letSuffix,
    tail,
    unknownKeys,
  };
}

// ─── Merge ───────────────────────────────────────────────────────────────────

export function mergeFmt(
  sortedFiles: { content: string; layer: number; template: string }[],
): string {
  const labels = sortedFiles.map((file, index) => `layer ${index} (template: ${file.template})`);
  const parsed = sortedFiles.map((file, index) => parseFmt(file.content, labels[index]));

  for (let i = 0; i < parsed.length; i++) {
    const unknown = parsed[i].unknownKeys[0];
    if (unknown !== undefined) {
      throw new Error(`${FILE}: unknown top-level key "${unknown}" in ${labels[i]}`);
    }
  }

  // Function args: normalized to a canonical sorted form, then required to match exactly.
  const functionArgs = parsed[0].functionArgs;
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].functionArgs !== functionArgs) {
      throw new Error(
        `${FILE}: function args mismatch — expected ${functionArgs}, got ${parsed[i].functionArgs} in ${labels[i]}`,
      );
    }
  }

  const programs = new Map<string, ProgramModel>();
  for (const layer of parsed) {
    for (const [name, program] of layer.programs) {
      let merged = programs.get(name);
      if (!merged) {
        merged = { fields: new Map() };
        programs.set(name, merged);
      }
      if (program.comment) merged.comment = program.comment;

      if (program.raw !== undefined) {
        // A non-attrset program cannot be deep-merged; highest layer wins. Anything this
        // drops is caught by the loss guard, which refuses rather than losing it quietly.
        merged.fields.clear();
        merged.raw = program.raw;
        continue;
      }

      merged.raw = undefined;
      for (const [path, value] of program.fields) {
        const previous = merged.fields.get(path);
        if (value.kind === 'bool' && previous?.kind === 'bool') {
          // `enable = true` — and every other boolean — wins over `false`.
          merged.fields.set(path, { kind: 'bool', value: previous.value || value.value });
          continue;
        }
        merged.fields.set(path, value);
      }
    }
  }

  const highest = parsed[parsed.length - 1];
  return prettyPrint({
    functionArgs,
    projectRootFile: highest.projectRootFile,
    projectRootFileComment: lastDefined(parsed.map((p) => p.projectRootFileComment)),
    programs,
    hasPrograms: parsed.some((p) => p.hasPrograms),
    programsComment: lastDefined(parsed.map((p) => p.programsComment)),
    letPrefix: highest.letPrefix,
    letSuffix: highest.letSuffix,
    tail: highest.tail,
    unknownKeys: [],
  });
}

function lastDefined(values: (string | undefined)[]): string | undefined {
  for (let index = values.length - 1; index >= 0; index--) {
    if (values[index] !== undefined) return values[index];
  }
  return undefined;
}

// ─── Pretty Print ────────────────────────────────────────────────────────────

function renderField(indent: string, key: string, value: FieldValue): string[] {
  if (value.kind === 'bool') return [`${indent}${key} = ${value.value};`];

  if (value.kind === 'list') {
    if (value.items.length === 0) return [`${indent}${key} = [ ];`];
    if (value.items.length === 1) return [`${indent}${key} = [ ${value.items[0]} ];`];
    return [
      `${indent}${key} = [`,
      ...value.items.map((item) => `${indent}  ${item}`),
      `${indent}];`,
    ];
  }

  // Raw values keep their own internal layout so nothing is reshaped — and so a second
  // merge of the same output reproduces them byte for byte.
  return `${indent}${key} = ${value.text};`.split('\n');
}

function renderProgram(name: string, program: ProgramModel): string[] {
  const lines: string[] = [];
  if (program.comment) lines.push(`      ${program.comment}`);

  if (program.raw !== undefined) {
    lines.push(...`      ${name} = ${program.raw};`.split('\n'));
    return lines;
  }

  const fields = program.fields;
  if (fields.size === 0) {
    lines.push(`      ${name} = { };`);
    return lines;
  }

  const enable = fields.get('enable');
  if (fields.size === 1 && enable?.kind === 'bool' && enable.value) {
    lines.push(`      ${name}.enable = true;`);
    return lines;
  }

  lines.push(`      ${name} = {`);
  if (enable) lines.push(...renderField('        ', 'enable', enable));
  for (const key of [...fields.keys()].sort(compare)) {
    if (key === 'enable') continue;
    lines.push(...renderField('        ', key, fields.get(key)!));
  }
  lines.push('      };');
  return lines;
}

function prettyPrint(model: ParsedFmt): string {
  const lines: string[] = [];

  lines.push(`${model.functionArgs}:`);
  lines.push('let');
  if (model.letPrefix) lines.push(...reindent(model.letPrefix, '  '));
  lines.push('  fmt = {');

  if (model.projectRootFileComment) lines.push(`    ${model.projectRootFileComment}`);
  lines.push(`    projectRootFile = ${model.projectRootFile};`);
  lines.push('');

  if (model.hasPrograms) {
    if (model.programsComment) lines.push(`    ${model.programsComment}`);
    lines.push('    programs = {');
    for (const name of [...model.programs.keys()].sort(compare)) {
      lines.push(...renderProgram(name, model.programs.get(name)!));
    }
    lines.push('    };');
    lines.push('');
  }

  lines.push('  };');
  if (model.letSuffix) lines.push(...reindent(model.letSuffix, '  '));
  lines.push('in');
  lines.push(model.tail);
  lines.push('');

  return lines.join('\n');
}
