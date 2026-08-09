// merge-flake.ts — Parser and base-preserving merger for flake.nix files

import { inventoryMaterial, maskNixTrivia } from './loss-guard.ts';

interface InputEntry {
  name: string;
  url: string;
  trailingComment: string;
}

interface CommentGroup {
  label: string; // e.g. "# registry"
  items: string[];
}

interface RegistryLine {
  name: string;
  expr: string;
}

interface WithRecAssignment {
  name: string;
  body: string; // the RHS up to the next assignment or closing brace
  raw: string; // `name = <rhs>;` exactly as it appeared in its source file
  indent: string; // leading whitespace of the line the assignment starts on
  leadingComments: string[]; // own-line comments directly above, trimmed
  start: number; // byte offset of the name in the file it was parsed from
  end: number; // byte offset just past the assignment's terminating `;`
}

interface ParsedFlake {
  description: string;
  inputPreambleComments: string[];
  inputGroups: CommentGroup[];
  outputParamGroups: CommentGroup[];
  outputParamExpressions: Map<string, string>;
  optionalOutputParams: Set<string>;
  outputsAlias: string | null;
  registryLines: RegistryLine[];
  pkgsAlias: string | null;
  withRecAssignments: WithRecAssignment[];
  finalInheritIds: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx;
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    if (depth === 0) return i;
    i++;
  }
  return -1;
}

function appendPendingComment(pending: string[], line: string): void {
  if (line || pending[pending.length - 1] !== '') pending.push(line);
}

function commentLabel(pending: string[]): string {
  let first = 0;
  let last = pending.length;
  while (first < last && pending[first] === '') first++;
  while (last > first && pending[last - 1] === '') last--;
  return pending.slice(first, last).join('\n');
}

function pushCommentBlock(
  lines: string[],
  label: string,
  indentation: string,
): void {
  for (const commentLine of label.split('\n')) {
    lines.push(commentLine ? `${indentation}${commentLine}` : '');
  }
}

// ─── Parse ───────────────────────────────────────────────────────────────────

function parseInputsBlock(content: string): CommentGroup[] {
  const inputsMatch = content.match(/inputs\s*=\s*\{/);
  if (!inputsMatch) return [];

  const braceStart = inputsMatch.index! + inputsMatch[0].length;
  const closingIdx = findMatchingBrace(content, braceStart);
  if (closingIdx === -1) return [];

  const body = content.slice(braceStart, closingIdx);
  const lines = body.split('\n');
  const groups: CommentGroup[] = [];
  let currentGroup: CommentGroup | null = null;
  let pendingComments: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (pendingComments.length > 0) appendPendingComment(pendingComments, '');
      continue;
    }

    if (trimmed.startsWith('#')) {
      if (currentGroup?.items.length) currentGroup = null;
      appendPendingComment(pendingComments, trimmed);
      continue;
    }

    const entryMatch = trimmed.match(
      /^([\w-]+)\.url\s*=\s*"([^"]+)"\s*;?\s*(#.*)?$/,
    );
    if (entryMatch) {
      const trailingComment = entryMatch[3] ? ` ${entryMatch[3]}` : '';
      const entry = `${entryMatch[1]}.url = "${entryMatch[2]}";${trailingComment}`;
      if (!currentGroup || pendingComments.length > 0) {
        currentGroup = { label: commentLabel(pendingComments), items: [] };
        groups.push(currentGroup);
        pendingComments = [];
      }
      currentGroup.items.push(entry);
    }
  }

  return groups;
}

function parseInputEntries(groups: CommentGroup[]): InputEntry[] {
  const entries: InputEntry[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      const m = item.match(/^([\w-]+)\.url\s*=\s*"([^"]+)"\s*;?\s*(#.*)?$/);
      if (m)
        entries.push({ name: m[1], url: m[2], trailingComment: m[3] ?? '' });
    }
  }
  return entries;
}

function parseOutputBinding(content: string): {
  groups: CommentGroup[];
  expressions: Map<string, string>;
  optional: Set<string>;
  alias: string | null;
} {
  const match = content.match(/outputs\s*=\s*(?:([a-zA-Z_][\w'-]*)\s*@\s*)?\{/);
  if (!match)
    return {
      groups: [],
      expressions: new Map(),
      optional: new Set(),
      alias: null,
    };

  const braceStart = match.index! + match[0].length;
  // Find the closing brace, then retain either suffix- or prefix-style @ aliases.
  let depth = 1;
  let i = braceStart;
  while (i < content.length && depth > 0) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') depth--;
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0)
    return {
      groups: [],
      expressions: new Map(),
      optional: new Set(),
      alias: null,
    };

  const body = content.slice(braceStart, i);
  const suffix = content.slice(i + 1);
  const aliasMatch = suffix.match(/^\s*@\s*([a-zA-Z_][\w'-]*)\s*:/);
  const lines = body.split('\n');
  const groups: CommentGroup[] = [];
  const expressions = new Map<string, string>();
  const optional = new Set<string>();
  let currentGroup: CommentGroup | null = null;
  let pendingComments: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (pendingComments.length > 0) appendPendingComment(pendingComments, '');
      continue;
    }

    if (trimmed.startsWith('#')) {
      if (currentGroup?.items.length) currentGroup = null;
      appendPendingComment(pendingComments, trimmed);
      continue;
    }

    const formals = trimmed
      .replace(/\s+#.*$/, '')
      .split(',')
      .map((part) => part.trim())
      .flatMap((expression) => {
        if (expression === '...')
          return [{ name: '...', expression, optional: false }];
        const formal = expression.match(/^([a-zA-Z][\w-]*)(\s*\?.+)?$/);
        if (!formal) return [];
        return [
          {
            name: formal[1],
            expression,
            optional: formal[2] !== undefined,
          },
        ];
      });

    if (formals.length > 0) {
      if (!currentGroup || pendingComments.length > 0) {
        currentGroup = { label: commentLabel(pendingComments), items: [] };
        groups.push(currentGroup);
        pendingComments = [];
      }
      for (const formal of formals) {
        currentGroup.items.push(formal.name);
        expressions.set(formal.name, formal.expression);
        if (formal.optional) optional.add(formal.name);
        else optional.delete(formal.name);
      }
    }
  }

  return {
    groups,
    expressions,
    optional,
    alias: match[1] ?? aliasMatch?.[1] ?? null,
  };
}

function parseInputPreambleComments(content: string): string[] {
  const inputsMatch = content.match(/inputs\s*=/);
  if (!inputsMatch) return [];

  return content
    .slice(0, inputsMatch.index)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('#'));
}

function parseRegistryLines(content: string): RegistryLine[] {
  // Find "system:" then the next "let ... in" block
  const systemMatch = content.match(/system:\s*\n/);
  if (!systemMatch) return [];

  const afterSystem = content.slice(systemMatch.index! + systemMatch[0].length);

  // Find "let"
  const letMatch = afterSystem.match(/\blet\b/);
  if (!letMatch) return [];

  const afterLet = afterSystem.slice(letMatch.index! + 3);
  const lines = afterLet.split('\n');
  const registryLines: RegistryLine[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // "in" marks the end of the let block
    if (trimmed === 'in' || trimmed.startsWith('in ')) break;

    // Match: name = expr;
    const m = trimmed.match(/^([\w-]+)\s*=\s*(.+);\s*$/);
    if (m) {
      registryLines.push({ name: m[1], expr: m[2] });
    }
  }

  return registryLines;
}

function parsePkgsAlias(content: string): string | null {
  // Keep this deliberately narrow: the alias is the plain `pkgs = ...;`
  // assignment between the system lambda and `with rec`. It may live in its
  // own let block in source files or in the first let after a surgical merge.
  const systemMatch = content.match(/system\s*:/);
  const withRecMatch = content.match(/with\s+rec\s*\{/);
  if (
    !systemMatch ||
    !withRecMatch ||
    withRecMatch.index! <= systemMatch.index!
  )
    return null;

  const body = content.slice(systemMatch.index!, withRecMatch.index!);
  const matches = [...body.matchAll(/\b(pkgs\s*=\s*[^;]+;)/g)];
  return matches.length > 0 ? matches[matches.length - 1][1].trim() : null;
}

/** Leading whitespace of the line `offset` sits on, or '' when it is not the first token. */
function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);
  return /^[ \t]*$/.test(prefix) ? prefix : '';
}

/** Own-line comments in the unbroken run directly above `offset`, trimmed, top-down. */
function commentsAbove(text: string, offset: number): string[] {
  let lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  if (!/^[ \t]*$/.test(text.slice(lineStart, offset))) return [];

  const comments: string[] = [];
  while (lineStart > 0) {
    const previousEnd = lineStart - 1;
    const previousStart =
      previousEnd === 0 ? 0 : text.lastIndexOf('\n', previousEnd - 1) + 1;
    const line = text.slice(previousStart, previousEnd).trim();
    if (!line.startsWith('#')) break;
    comments.unshift(line);
    lineStart = previousStart;
  }
  return comments;
}

/**
 * Locate the `with rec { ... }` block, scanning trivia-masked source so a brace, a
 * `with rec` or a delimiter inside a comment or a string literal cannot be mistaken
 * for structure. Offsets index the original `content` — `maskNixTrivia` blanks in
 * place and keeps every position.
 */
function findWithRecBody(
  content: string,
  code: string,
): { braceStart: number; closingIdx: number } | null {
  const match = code.match(/with\s+rec\s*\{/);
  if (!match) return null;

  const braceStart = match.index! + match[0].length;
  const closingIdx = findMatchingBrace(code, braceStart);
  return closingIdx === -1 ? null : { braceStart, closingIdx };
}

function parseWithRecAssignments(content: string): WithRecAssignment[] {
  const code = maskNixTrivia(content);
  const block = findWithRecBody(content, code);
  if (!block) return [];

  const { braceStart, closingIdx } = block;
  const body = content.slice(braceStart, closingIdx);
  // Structure is read off the masked copy; every slice is taken from the original at
  // the same offsets, so comments and string contents travel with the assignment.
  const scan = code.slice(braceStart, closingIdx);

  // Parse assignments by tracking brace depth
  const assignments: WithRecAssignment[] = [];
  let nameStart = -1;
  let nameEnd = -1;
  let rhsStart = -1;
  let depth = 0;
  let inAssignment = false;

  // The raw source of an assignment is spliced verbatim into another file when a
  // lower layer contributes a binding the base does not have, so every assignment
  // carries the offsets it was cut from alongside the parsed name and body.
  const record = (end: number): void => {
    assignments.push({
      // Whitespace and stray `;` between tokens are not part of the name.
      name: body.slice(nameStart, nameEnd).replace(/[\s;]/g, ''),
      body: body
        .slice(rhsStart, end)
        .trim()
        .replace(/\s*;\s*$/, ''),
      raw: body.slice(nameStart, end).trimEnd(),
      indent: lineIndentAt(body, nameStart),
      leadingComments: commentsAbove(body, nameStart),
      start: braceStart + nameStart,
      end: braceStart + end,
    });
  };

  let pos = 0;
  while (pos < scan.length) {
    const char = scan[pos];
    if (!inAssignment) {
      if (char === '=' && nameStart !== -1) {
        inAssignment = true;
        rhsStart = pos + 1;
        pos++;
        continue;
      }
      // `\r` counts as whitespace: a CRLF source must not start the name — and with
      // it `indent`, `raw` and the splice offsets — on the previous line.
      if (!/[\s;]/.test(char)) {
        if (nameStart === -1) nameStart = pos;
        nameEnd = pos + 1;
      }
      pos++;
    } else {
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        // End of with rec block or stray } — the assignment stops here.
        if (depth < 0) break;
      }
      pos++;
      // Assignment ends with ; at depth 0. Only the trailing ; is stripped from the
      // body; a } belongs to attrset/function-call syntax (e.g.
      // "import ./nix/packages.nix { inherit pkgs; }") and must be preserved for
      // callers inspecting the parsed assignment.
      if (char === ';' && depth === 0) {
        record(pos);
        nameStart = -1;
        nameEnd = -1;
        rhsStart = -1;
        depth = 0;
        inAssignment = false;
      }
    }
  }

  // Handle last assignment without trailing semicolon check
  if (nameStart !== -1 && rhsStart !== -1 && body.slice(rhsStart, pos).trim()) {
    record(pos);
  }

  return assignments;
}

function parseFinalInheritIds(content: string): string[] {
  const inherit = findFinalInherit(content);
  return inherit ? inherit.ids : [];
}

/**
 * The final `{ inherit ...; }` attrset after the `with rec { ... };` block, with the
 * offset of its terminating `;` so identifiers can be spliced into it.
 */
function findFinalInherit(
  content: string,
): { ids: string[]; idsText: string; semicolon: number } | null {
  const code = maskNixTrivia(content);
  const block = findWithRecBody(content, code);
  if (!block) return null;

  // After the with rec block's closing }, find { inherit ... ; }
  const afterRec = code.slice(block.closingIdx);
  const match = afterRec.match(/\{\s*inherit\s+([^;]+);\s*\}/);
  if (!match) return null;

  const idsText = match[1];
  return {
    // Identifiers are read from the masked copy so a commented-out name in an
    // exploded inherit list is not mistaken for one the flake exposes.
    ids: idsText.trim().split(/\s+/).filter(Boolean),
    idsText,
    semicolon: block.closingIdx + match.index! + match[0].indexOf(';'),
  };
}

function extractInheritIds(assignmentBody: string): string[] {
  // Extract inherit identifiers from an assignment body
  // Matches: inherit id1 id2 id3;
  const inheritMatch = assignmentBody.match(/inherit\s+([^;]+);/);
  if (!inheritMatch) return [];
  return inheritMatch[1].trim().split(/\s+/);
}

function extractPackagesInheritIds(assignments: WithRecAssignment[]): string[] {
  const pkg = assignments.find((a) => a.name === 'packages');
  if (!pkg) return [];
  return extractInheritIds(pkg.body);
}

export function parseFlake(content: string): ParsedFlake {
  const descriptionMatch = content.match(/description\s*=\s*"([^"]+)"/);
  const description = descriptionMatch ? descriptionMatch[1] : '';

  const inputPreambleComments = parseInputPreambleComments(content);
  const inputGroups = parseInputsBlock(content);
  const outputBinding = parseOutputBinding(content);
  const registryLines = parseRegistryLines(content);
  const pkgsAlias = parsePkgsAlias(content);
  const withRecAssignments = parseWithRecAssignments(content);
  const finalInheritIds = parseFinalInheritIds(content);

  return {
    description,
    inputPreambleComments,
    inputGroups,
    outputParamGroups: outputBinding.groups,
    outputParamExpressions: outputBinding.expressions,
    optionalOutputParams: outputBinding.optional,
    outputsAlias: outputBinding.alias,
    registryLines,
    pkgsAlias,
    withRecAssignments,
    finalInheritIds,
  };
}

interface BracedRegion {
  open: number;
  close: number;
}

/**
 * `scan` is the text the pattern and the brace matcher run against; it defaults to
 * `content` but callers that must not be fooled by braces inside comments or string
 * literals pass the trivia-masked copy. Offsets are identical either way.
 */
function findBracedRegion(
  content: string,
  pattern: RegExp,
  scan: string = content,
): BracedRegion | null {
  const match = scan.match(pattern);
  if (!match) return null;

  const relativeOpen = match[0].lastIndexOf('{');
  const open = match.index! + relativeOpen;
  const close = findMatchingBrace(scan, open + 1);
  return close === -1 ? null : { open, close };
}

function inputName(item: string): string | null {
  return item.match(/^\s*([\w-]+)\.url\s*=/)?.[1] ?? null;
}

function insertBeforeClosingBrace(
  content: string,
  close: number,
  block: string,
): string {
  const closingLineStart = content.lastIndexOf('\n', close) + 1;
  const beforeBrace = content.slice(closingLineStart, close);

  if (/^\s*$/.test(beforeBrace)) {
    return (
      content.slice(0, closingLineStart) +
      block +
      '\n' +
      content.slice(closingLineStart)
    );
  }

  const closingIndent = beforeBrace.match(/^\s*/)?.[0] ?? '';
  return (
    content.slice(0, close) +
    '\n' +
    block +
    '\n' +
    closingIndent +
    content.slice(close)
  );
}

function insertMissingInputs(
  content: string,
  mergedGroups: CommentGroup[],
): string {
  const region = findBracedRegion(content, /inputs\s*=\s*\{/);
  if (!region)
    throw new Error(
      'Cannot merge flake.nix: inputs attribute set was not found',
    );

  const baseNames = new Set(
    parseInputEntries(parseInputsBlock(content)).map((entry) => entry.name),
  );
  const body = content.slice(region.open + 1, region.close);
  const entryIndent = body.match(/^([ \t]*)[\w-]+\.url\s*=/m)?.[1] ?? '    ';
  const blocks: string[] = [];

  for (const group of mergedGroups) {
    const missing = group.items.filter((item) => {
      const name = inputName(item);
      return name !== null && !baseNames.has(name);
    });
    if (missing.length === 0) continue;

    const lines: string[] = [];
    if (group.label) pushCommentBlock(lines, group.label, entryIndent);
    for (const item of missing) {
      const name = inputName(item)!;
      baseNames.add(name);
      lines.push(entryIndent + item.trimStart());
    }
    blocks.push(lines.join('\n'));
  }

  return blocks.length === 0
    ? content
    : insertBeforeClosingBrace(content, region.close, blocks.join('\n\n'));
}

function insertMissingOutputParams(
  content: string,
  mergedGroups: CommentGroup[],
  expressionByName: Map<string, string>,
): string {
  const region = findBracedRegion(
    content,
    /outputs\s*=\s*(?:[a-zA-Z_][\w'-]*\s*@\s*)?\{/,
  );
  if (!region)
    throw new Error(
      'Cannot merge flake.nix: outputs argument set was not found',
    );

  const baseBinding = parseOutputBinding(content);
  const baseNames = new Set(baseBinding.groups.flatMap((group) => group.items));
  const rawMissingGroups = mergedGroups
    .map((group) => ({
      label: group.label,
      items: group.items.filter((item) => !baseNames.has(item)),
    }))
    .filter((group) => group.items.length > 0);

  const ellipsisGroup = rawMissingGroups.find((group) =>
    group.items.includes('...'),
  );
  const missingGroups = rawMissingGroups
    .map((group) => ({
      label: group.label,
      items: group.items.filter((item) => item !== '...'),
    }))
    .filter((group) => group.items.length > 0);
  if (ellipsisGroup) {
    missingGroups.push({
      label: ellipsisGroup.items.length === 1 ? ellipsisGroup.label : '',
      items: ['...'],
    });
  }

  if (missingGroups.length === 0) return content;

  for (const group of missingGroups) {
    for (const item of group.items) baseNames.add(item);
  }

  const body = content.slice(region.open + 1, region.close);
  const missingNames = missingGroups.flatMap((group) => group.items);

  // Preserve compact binders byte-for-byte except for the inserted names.
  if (!body.includes('\n')) {
    const ellipsisOffset = body.indexOf('...');
    if (ellipsisOffset >= 0) {
      const ordinary = missingNames.filter((name) => name !== '...');
      if (ordinary.length === 0) return content;
      const insertAt = region.open + 1 + ellipsisOffset;
      return (
        content.slice(0, insertAt) +
        ordinary.map((name) => expressionByName.get(name) ?? name).join(', ') +
        ', ' +
        content.slice(insertAt)
      );
    }

    const trimmedBody = body.trimEnd();
    const separator = trimmedBody
      ? trimmedBody.endsWith(',')
        ? ' '
        : ', '
      : '';
    const rendered = missingNames
      .map((name) => expressionByName.get(name) ?? name)
      .join(', ');
    return (
      content.slice(0, region.close) +
      separator +
      rendered +
      content.slice(region.close)
    );
  }

  const usesLeadingCommas =
    /^\s*,/m.test(body) || !/[\w)-]\s*,\s*(?:#.*)?$/m.test(body);
  const ellipsisMatch = body.match(/^\s*(?:,\s*)?\.\.\.\s*,?\s*(?:#.*)?$/m);
  const beforeInsertion = ellipsisMatch
    ? body.slice(0, ellipsisMatch.index)
    : body;
  const precedingFormalHasTrailingComma =
    beforeInsertion
      .split('\n')
      .reverse()
      .map((line) => line.replace(/\s+#.*$/, '').trim())
      .find((line) => line.length > 0)
      ?.endsWith(',') ?? false;
  const renderWithLeadingCommas =
    usesLeadingCommas || !precedingFormalHasTrailingComma;
  const entryIndent = usesLeadingCommas
    ? (body.match(/^([ \t]*),\s*(?:[a-zA-Z_]|\.\.\.)/m)?.[1] ?? '    ')
    : (body.match(/^([ \t]*)(?:[a-zA-Z_]|\.\.\.)/m)?.[1] ?? '      ');
  const commentIndent = usesLeadingCommas ? `${entryIndent}  ` : entryIndent;
  const blocks: string[] = [];

  for (const group of missingGroups) {
    const lines: string[] = [];
    if (group.label) pushCommentBlock(lines, group.label, commentIndent);
    for (const name of group.items) {
      const expression = expressionByName.get(name) ?? name;
      if (renderWithLeadingCommas) lines.push(`${entryIndent}, ${expression}`);
      else if (name === '...') lines.push(`${entryIndent}...`);
      else lines.push(`${entryIndent}${expression},`);
    }
    blocks.push(lines.join('\n'));
  }

  const block = blocks.join('\n\n');
  if (ellipsisMatch) {
    const insertAt = region.open + 1 + ellipsisMatch.index!;
    return content.slice(0, insertAt) + block + '\n' + content.slice(insertAt);
  }

  return insertBeforeClosingBrace(content, region.close, block);
}

function findSystemLetInsertion(
  content: string,
): { at: number; indent: string } | null {
  const systemMatch = content.match(/system\s*:/);
  if (!systemMatch) return null;

  const afterSystem = content.slice(systemMatch.index! + systemMatch[0].length);
  const letMatch = afterSystem.match(/\blet\b/);
  if (!letMatch) return null;

  const afterLetStart =
    systemMatch.index! +
    systemMatch[0].length +
    letMatch.index! +
    letMatch[0].length;
  const afterLet = content.slice(afterLetStart);
  const inMatch = afterLet.match(/^([ \t]*)in(?:\s|$)/m);
  if (!inMatch) return null;

  const beforeIn = afterLet.slice(0, inMatch.index);
  const assignmentIndents = [...beforeIn.matchAll(/^([ \t]+)[\w-]+\s*=/gm)];
  const indent = assignmentIndents[0]?.[1] ?? `${inMatch[1]}  `;
  return { at: afterLetStart + inMatch.index!, indent };
}

function insertMissingRegistryLines(
  content: string,
  mergedLines: RegistryLine[],
  mergedPkgsAlias: string | null,
): string {
  const baseNames = new Set(
    parseRegistryLines(content).map((line) => line.name),
  );
  const additions = mergedLines
    .filter((line) => !baseNames.has(line.name))
    .map((line) => `${line.name} = ${line.expr};`);

  if (mergedPkgsAlias && !parsePkgsAlias(content))
    additions.push(mergedPkgsAlias);
  if (additions.length === 0) return content;

  const insertion = findSystemLetInsertion(content);
  if (!insertion) {
    throw new Error('Cannot merge flake.nix: system let block was not found');
  }

  const block = additions.map((line) => insertion.indent + line).join('\n');
  return (
    content.slice(0, insertion.at) + block + '\n' + content.slice(insertion.at)
  );
}

function insertMissingPackageInherits(
  content: string,
  mergedIds: string[],
): string {
  if (mergedIds.length === 0) return content;

  const code = maskNixTrivia(content);
  const withRecRegion = findBracedRegion(content, /with\s+rec\s*\{/, code);
  if (!withRecRegion)
    throw new Error('Cannot merge flake.nix: with rec block was not found');

  const withRecBody = code.slice(withRecRegion.open + 1, withRecRegion.close);
  const packagesMatch = withRecBody.match(/\bpackages\s*=\s*import\b/);
  if (!packagesMatch) return content;

  const packagesStart = withRecRegion.open + 1 + packagesMatch.index!;
  const argsOpen = code.indexOf('{', packagesStart + packagesMatch[0].length);
  if (argsOpen === -1 || argsOpen >= withRecRegion.close) {
    throw new Error(
      'Cannot merge flake.nix: packages import argument set was not found',
    );
  }

  const argsClose = findMatchingBrace(code, argsOpen + 1);
  if (argsClose === -1 || argsClose > withRecRegion.close) {
    throw new Error(
      'Cannot merge flake.nix: packages import argument set is unbalanced',
    );
  }

  const argsBody = code.slice(argsOpen + 1, argsClose);
  const inheritMatch = argsBody.match(/\binherit\b([\s\S]*?);/);
  if (!inheritMatch) return content;

  const existingIds = new Set(
    (inheritMatch[1].match(/[a-zA-Z_][\w'-]*/g) ?? []).filter(
      (id) => id !== 'inherit',
    ),
  );
  const missing = mergedIds.filter((id) => !existingIds.has(id)).sort();
  if (missing.length === 0) return content;

  const semicolon =
    argsOpen + 1 + inheritMatch.index! + inheritMatch[0].lastIndexOf(';');
  return spliceInheritIds(content, semicolon, inheritMatch[1], missing);
}

/**
 * Add identifiers to an existing `inherit ...;`, matching how the list is already
 * rendered: appended on the same line for a compact list, one per line for the
 * exploded form treefmt produces once the list grows.
 */
function spliceInheritIds(
  content: string,
  semicolon: number,
  inheritText: string,
  missing: string[],
): string {
  const appendInline = (): string =>
    content.slice(0, semicolon) +
    ' ' +
    missing.join(' ') +
    content.slice(semicolon);

  if (!inheritText.includes('\n')) return appendInline();

  const semicolonLineStart = content.lastIndexOf('\n', semicolon) + 1;
  const beforeSemicolon = content.slice(semicolonLineStart, semicolon);
  if (!/^\s*$/.test(beforeSemicolon)) return appendInline();

  const block = missing.map((id) => beforeSemicolon + id).join('\n');
  return (
    content.slice(0, semicolonLineStart) +
    block +
    '\n' +
    content.slice(semicolonLineStart)
  );
}

function quoteNames(names: string[]): string {
  return names.map((name) => `'${name}'`).join(', ');
}

/**
 * Move a captured source block from one indentation column to another. Only the
 * continuation lines shift; the first line is placed by the caller.
 */
function shiftIndent(raw: string, delta: number): string {
  if (delta === 0) return raw;
  return raw
    .split('\n')
    .map((line, index) => {
      if (index === 0 || line.trim() === '') return line;
      if (delta > 0) return ' '.repeat(delta) + line;
      const leading = line.match(/^[ \t]*/)![0];
      return line.slice(Math.min(leading.length, -delta));
    })
    .join('\n');
}

function renderWithRecAssignment(
  assignment: WithRecAssignment,
  indent: string,
): string {
  const lines = assignment.leadingComments.map((comment) => indent + comment);
  const raw = assignment.raw.endsWith(';')
    ? assignment.raw
    : `${assignment.raw};`;
  lines.push(
    indent + shiftIndent(raw, indent.length - assignment.indent.length),
  );
  return lines.join('\n');
}

/**
 * Splice the `with rec` bindings a lower layer contributes and the base does not
 * have. `rec` makes the block order-independent, so appending before the closing
 * brace is enough — no dependency sort is needed, and the base keeps its bytes.
 */
function insertMissingWithRecAssignments(
  content: string,
  merged: WithRecAssignment[],
): string {
  const baseNames = new Set(
    parseWithRecAssignments(content).map((assignment) => assignment.name),
  );
  const missing = merged.filter(
    (assignment) => !baseNames.has(assignment.name),
  );
  if (missing.length === 0) return content;

  const code = maskNixTrivia(content);
  const region = findBracedRegion(content, /with\s+rec\s*\{/, code);
  if (!region)
    throw new Error(
      `Cannot merge flake.nix: with rec block was not found, so ` +
        `${quoteNames(missing.map((assignment) => assignment.name))} could not be spliced`,
    );

  const scan = code.slice(region.open + 1, region.close);
  const entryIndent = scan.match(/^([ \t]*)[\w'-]+\s*=/m)?.[1] ?? '          ';
  const block = missing
    .map((assignment) => renderWithRecAssignment(assignment, entryIndent))
    .join('\n');

  return insertBeforeClosingBrace(content, region.close, block);
}

/** Splice the identifiers a lower layer exposes from the flake into the base's final attrset. */
function insertMissingFinalInherits(
  content: string,
  mergedIds: string[],
): string {
  const target = findFinalInherit(content);
  const baseIds = new Set(target?.ids ?? []);
  const missing = mergedIds.filter((id) => !baseIds.has(id)).sort();
  if (missing.length === 0) return content;

  if (!target)
    throw new Error(
      `Cannot merge flake.nix: the final inherit attribute set was not found, so ` +
        `${quoteNames(missing)} could not be spliced`,
    );

  return spliceInheritIds(content, target.semicolon, target.idsText, missing);
}

/**
 * The last top-level `{ ... }` inside `[start, end)` — an assignment's argument set.
 * `scan` must be trivia-masked: a brace inside a `''…''` shell fragment is text, not
 * structure.
 */
function findTrailingBracedRegion(
  scan: string,
  start: number,
  end: number,
): BracedRegion | null {
  let depth = 0;
  let open = -1;
  let region: BracedRegion | null = null;

  for (let index = start; index < end; index++) {
    if (scan[index] === '{') {
      if (depth === 0) open = index;
      depth++;
    } else if (scan[index] === '}') {
      depth--;
      if (depth === 0 && open !== -1) region = { open, close: index };
      if (depth < 0) break;
    }
  }
  return region;
}

interface ArgEntry {
  kind: 'inherit' | 'binding';
  /** The names this entry brings into scope. */
  names: string[];
  /** The entry exactly as it appeared, terminated by `;`. */
  text: string;
  indent: string;
}

/**
 * `segment` is the entry's original source and becomes `text`; `scan` is the same
 * span with comments and string literals blanked and is what the shape is read from,
 * so an `inherit` or a name that only appears inside trivia is not taken for one.
 */
function classifyArgEntry(segment: string, scan: string): ArgEntry | null {
  const trimmed = segment.trim();
  const shape = scan.trim();
  if (!trimmed || !shape) return null;

  const offset = segment.length - segment.trimStart().length;
  const indent = lineIndentAt(segment, offset);
  const inherit = shape.match(/^inherit\b([\s\S]*);$/);
  if (inherit) {
    // `inherit (foo) a b;` takes its names from foo — the parenthesised source is
    // not itself an inherited identifier.
    const names = inherit[1]
      .replace(/^\s*\([\s\S]*?\)/, '')
      .match(/[a-zA-Z_][\w'-]*/g);
    return names ? { kind: 'inherit', names, text: trimmed, indent } : null;
  }

  const binding = shape.match(/^([a-zA-Z_][\w'-]*)\s*=/);
  return binding
    ? { kind: 'binding', names: [binding[1]], text: trimmed, indent }
    : null;
}

/**
 * Split an argument set into its entries. Delimiters are counted on the trivia-masked
 * copy: a `;` inside a `shellHook = '' … ''` fragment or a comment is text, and
 * splitting on it would store — and later splice — a truncated, unparseable entry.
 */
function parseArgEntries(
  content: string,
  code: string,
  region: BracedRegion,
): ArgEntry[] {
  const body = content.slice(region.open + 1, region.close);
  const scan = code.slice(region.open + 1, region.close);
  const entries: ArgEntry[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < scan.length; index++) {
    const char = scan[index];
    if (char === '{' || char === '[' || char === '(') depth++;
    else if (char === '}' || char === ']' || char === ')') depth--;
    else if (char === ';' && depth === 0) {
      const entry = classifyArgEntry(
        body.slice(start, index + 1),
        scan.slice(start, index + 1),
      );
      if (entry) entries.push(entry);
      start = index + 1;
    }
  }
  return entries;
}

function insertArgEntry(
  content: string,
  assignmentName: string,
  entry: ArgEntry,
  lostName: string,
): string {
  const target = parseWithRecAssignments(content).find(
    (assignment) => assignment.name === assignmentName,
  );
  if (!target) return content;

  const code = maskNixTrivia(content);
  const region = findTrailingBracedRegion(code, target.start, target.end);
  if (!region) return content;

  const scan = code.slice(region.open + 1, region.close);
  const entryIndent = scan.match(/^([ \t]*)\S/m)?.[1] ?? '';

  if (entry.kind === 'inherit') {
    const inheritMatch = scan.match(/\binherit\b([\s\S]*?);/);
    if (!inheritMatch)
      return insertBeforeClosingBrace(
        content,
        region.close,
        `${entryIndent}inherit ${lostName};`,
      );
    const semicolon =
      region.open + 1 + inheritMatch.index! + inheritMatch[0].lastIndexOf(';');
    return spliceInheritIds(content, semicolon, inheritMatch[1], [lostName]);
  }

  const rendered = shiftIndent(
    entry.text,
    entryIndent.length - entry.indent.length,
  );
  return insertBeforeClosingBrace(
    content,
    region.close,
    entryIndent + rendered,
  );
}

/**
 * Last-write-wins settles which body a contested `with rec` binding keeps, but it may
 * not delete a name outright: `devShells` superseded by a layer that drops
 * `shellHook = ...` from the import's argument set would lose `shellHook` entirely.
 * Rescue exactly the argument entries whose names survive nowhere else in the merged
 * file — anything still reachable stays where the winning layer put it, so the base
 * is not rewritten for names it already carries.
 */
function rescueLostArgEntries(
  content: string,
  parsed: ParsedFlake[],
  sources: string[],
): string {
  const required = new Set<string>();
  for (const source of sources) {
    const inventory = inventoryMaterial(source);
    for (const name of inventory.bindings) required.add(name);
    for (const name of inventory.inherited) required.add(name);
  }

  // Ascending layers, so the highest layer that offers a rescue for a name wins.
  const candidates = new Map<
    string,
    { assignmentName: string; entry: ArgEntry }
  >();
  for (const [index, flake] of parsed.entries()) {
    const source = sources[index];
    const code = maskNixTrivia(source);
    for (const assignment of flake.withRecAssignments) {
      const region = findTrailingBracedRegion(
        code,
        assignment.start,
        assignment.end,
      );
      if (!region) continue;
      for (const entry of parseArgEntries(source, code, region)) {
        for (const name of entry.names) {
          candidates.set(name, { assignmentName: assignment.name, entry });
        }
      }
    }
  }

  for (;;) {
    const actual = inventoryMaterial(content);
    const lost = [...required].find(
      (name) =>
        !actual.bindings.has(name) &&
        !actual.inherited.has(name) &&
        candidates.has(name),
    );
    if (lost === undefined) return content;

    const candidate = candidates.get(lost)!;
    // One attempt per name, whatever the outcome: the candidate set shrinks on every
    // pass, so this terminates, and a name that stays lost is left to the loss guard,
    // which names every remaining one at once.
    candidates.delete(lost);
    content = insertArgEntry(
      content,
      candidate.assignmentName,
      candidate.entry,
      lost,
    );
  }
}

/**
 * An identifier exposed by the final attrset has to be bound by the merged file, or
 * the result parses and then fails to evaluate — a worse outcome than refusing.
 */
function assertFinalInheritsAreBound(
  content: string,
  requiredIds: string[],
): void {
  if (requiredIds.length === 0) return;

  const bound = new Set<string>();
  for (const assignment of parseWithRecAssignments(content))
    bound.add(assignment.name);
  for (const line of parseRegistryLines(content)) bound.add(line.name);
  const alias = parsePkgsAlias(content);
  if (alias) bound.add(alias.split('=')[0].trim());
  for (const group of parseOutputBinding(content).groups)
    for (const item of group.items) bound.add(item);

  const unbound = requiredIds.filter((id) => !bound.has(id));
  if (unbound.length > 0)
    throw new Error(
      `Cannot merge flake.nix: final inherit ${quoteNames(unbound)} ` +
        `${unbound.length === 1 ? 'is' : 'are'} not bound by the merged with rec block`,
    );
}

function assertMergeInvariants(
  content: string,
  mergedInputGroups: CommentGroup[],
  mergedOutputGroups: CommentGroup[],
): void {
  const outputInputs = new Set(
    parseInputEntries(parseInputsBlock(content)).map((entry) => entry.name),
  );
  const outputParams = new Set(
    parseOutputBinding(content).groups.flatMap((group) => group.items),
  );
  const optionalOutputParams = parseOutputBinding(content).optional;
  const requiredInputs = new Set(
    mergedInputGroups.flatMap((group) =>
      group.items
        .map(inputName)
        .filter((name): name is string => name !== null),
    ),
  );
  const requiredParams = new Set(
    mergedOutputGroups.flatMap((group) => group.items),
  );

  for (const name of requiredInputs) {
    if (!outputInputs.has(name)) {
      throw new Error(
        `Cannot merge flake.nix: input '${name}' disappeared from the merged file`,
      );
    }
  }
  for (const name of requiredParams) {
    if (!outputParams.has(name)) {
      throw new Error(
        `Cannot merge flake.nix: outputs argument '${name}' disappeared from the merged file`,
      );
    }
  }

  if (!outputParams.has('...')) {
    for (const name of outputInputs) {
      if (!outputParams.has(name)) {
        throw new Error(
          `Cannot merge flake.nix: input '${name}' is not accepted by the outputs argument set`,
        );
      }
    }
    for (const name of outputParams) {
      if (
        name !== 'self' &&
        !outputInputs.has(name) &&
        !optionalOutputParams.has(name)
      ) {
        throw new Error(
          `Cannot merge flake.nix: outputs argument '${name}' has no matching input`,
        );
      }
    }
  }
}

// ─── Merge ───────────────────────────────────────────────────────────────────

export function mergeFlake(
  sortedFiles: { content: string; layer: number; template: string }[],
): string {
  if (sortedFiles.length === 0)
    throw new Error('Cannot merge flake.nix: no files were provided');

  const parsed = sortedFiles.map((f) => parseFlake(f.content));

  // Merge input entries
  const mergedInputs = mergeInputEntries(parsed);

  // Merge output params
  const mergedOutputParams = mergeOutputParams(parsed);
  const mergedOutputExpressions = new Map<string, string>();
  for (const flake of parsed) {
    for (const [name, expression] of flake.outputParamExpressions) {
      mergedOutputExpressions.set(name, expression);
    }
  }

  // Merge registry lines
  const mergedRegistries = mergeRegistryLines(parsed);

  // Include pkgs alias if any template defines it — needed because
  // packages inherit IDs are unioned across templates and may reference pkgs
  // even if the highest-layer template does not define the alias.
  // Use last non-null (highest layer) for LWW consistency.
  const pkgsAliases = parsed.flatMap((p) => (p.pkgsAlias ? [p.pkgsAlias] : []));
  const pkgsAlias = pkgsAliases[pkgsAliases.length - 1] ?? null;

  // Merge packages inherit across all layers
  const allPackageInherits = new Set<string>();
  for (const p of parsed) {
    for (const id of extractPackagesInheritIds(p.withRecAssignments)) {
      allPackageInherits.add(id);
    }
  }

  // Merge the `with rec` derivation bindings and the identifiers the flake exposes
  const mergedWithRec = mergeWithRecAssignments(parsed);
  const mergedFinalInherits = mergeFinalInheritIds(parsed);

  // Preserve the highest layer byte-for-byte and splice in only union members
  // missing from it. This keeps comments and syntax the parser does not model
  // attached to their original lines instead of routing the file through a
  // lossy pretty-printer.
  let content = sortedFiles[sortedFiles.length - 1].content;
  content = insertMissingInputs(content, mergedInputs);
  content = insertMissingOutputParams(
    content,
    mergedOutputParams,
    mergedOutputExpressions,
  );
  content = insertMissingRegistryLines(content, mergedRegistries, pkgsAlias);
  content = insertMissingWithRecAssignments(content, mergedWithRec);
  content = insertMissingPackageInherits(content, [...allPackageInherits]);
  content = insertMissingFinalInherits(content, mergedFinalInherits);
  content = rescueLostArgEntries(
    content,
    parsed,
    sortedFiles.map((f) => f.content),
  );
  assertFinalInheritsAreBound(content, mergedFinalInherits);
  assertMergeInvariants(content, mergedInputs, mergedOutputParams);
  return content;
}

/**
 * Union the `with rec` bindings across layers, last-write-wins by name and keeping the
 * position at which a name was first seen so the spliced order stays deterministic.
 */
function mergeWithRecAssignments(parsed: ParsedFlake[]): WithRecAssignment[] {
  const order: string[] = [];
  const byName = new Map<string, WithRecAssignment>();

  for (const p of parsed) {
    for (const assignment of p.withRecAssignments) {
      if (!byName.has(assignment.name)) order.push(assignment.name);
      byName.set(assignment.name, assignment);
    }
  }

  return order.map((name) => byName.get(name)!);
}

function mergeFinalInheritIds(parsed: ParsedFlake[]): string[] {
  const ids = new Set<string>();
  for (const p of parsed) {
    for (const id of p.finalInheritIds) ids.add(id);
  }
  return [...ids];
}

function mergeInputEntries(parsed: ParsedFlake[]): CommentGroup[] {
  const entryByInput = new Map<string, InputEntry>();
  const inputToGroup = new Map<string, string>();

  for (const p of parsed) {
    const entries = parseInputEntries(p.inputGroups);
    for (const entry of entries) {
      entryByInput.set(entry.name, entry);
    }
    for (const group of p.inputGroups) {
      for (const item of group.items) {
        const name = item.match(/^([\w-]+)\./)?.[1];
        if (name) {
          inputToGroup.set(name, group.label);
        }
      }
    }
  }

  // Build groups
  const groupMap = new Map<string, string[]>();
  for (const [name, input] of entryByInput) {
    const group = inputToGroup.get(name) ?? '';
    const trailingComment = input.trailingComment
      ? ` ${input.trailingComment}`
      : '';
    const entry = `    ${name}.url = "${input.url}";${trailingComment}`;
    if (!groupMap.has(group)) groupMap.set(group, []);
    groupMap.get(group)!.push(entry);
  }

  const groups: CommentGroup[] = [];
  for (const [label, items] of groupMap) {
    items.sort((a, b) => a.localeCompare(b));
    groups.push({ label, items });
  }

  groups.sort((a, b) => {
    if (a.label === '' && b.label !== '') return -1;
    if (a.label !== '' && b.label === '') return 1;
    return a.label.localeCompare(b.label);
  });

  return groups;
}

function mergeOutputParams(parsed: ParsedFlake[]): CommentGroup[] {
  const paramToGroup = new Map<string, string>();
  const allParams = new Set<string>();

  for (const p of parsed) {
    for (const group of p.outputParamGroups) {
      for (const item of group.items) {
        allParams.add(item);
        paramToGroup.set(item, group.label);
      }
    }
  }

  const groupMap = new Map<string, string[]>();
  for (const name of allParams) {
    const group = paramToGroup.get(name) ?? '';
    if (!groupMap.has(group)) groupMap.set(group, []);
    groupMap.get(group)!.push(name);
  }

  const groups: CommentGroup[] = [];
  for (const [label, items] of groupMap) {
    items.sort((a, b) => {
      if (a === 'self') return -1;
      if (b === 'self') return 1;
      if (a === '...') return 1;
      if (b === '...') return -1;
      return a.localeCompare(b);
    });
    groups.push({ label, items });
  }

  groups.sort((a, b) => {
    if (a.label === '' && b.label !== '') return -1;
    if (a.label !== '' && b.label === '') return 1;
    return a.label.localeCompare(b.label);
  });

  return groups;
}

function mergeRegistryLines(parsed: ParsedFlake[]): RegistryLine[] {
  const exprByName = new Map<string, string>();
  const allNames = new Set<string>();

  for (const p of parsed) {
    for (const line of p.registryLines) {
      allNames.add(line.name);
      exprByName.set(line.name, line.expr);
    }
  }

  return [...allNames]
    .sort()
    .map((name) => ({ name, expr: exprByName.get(name)! }));
}
