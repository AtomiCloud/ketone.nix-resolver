// merge-flake.ts — Parser and base-preserving merger for flake.nix files

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

function parseWithRecAssignments(content: string): WithRecAssignment[] {
  // Find "with rec {"
  const match = content.match(/with\s+rec\s*\{/);
  if (!match) return [];

  const braceStart = match.index! + match[0].length;
  const closingIdx = findMatchingBrace(content, braceStart);
  if (closingIdx === -1) return [];

  const body = content.slice(braceStart, closingIdx);

  // Parse assignments by tracking brace depth
  const assignments: WithRecAssignment[] = [];
  let currentName = '';
  let currentBody = '';
  let depth = 0;
  let inAssignment = false;

  let pos = 0;
  while (pos < body.length) {
    const char = body[pos];
    if (!inAssignment) {
      if (char === '=' && currentName.trim()) {
        inAssignment = true;
        pos++;
        continue;
      }
      if (char === '#') {
        // Skip line comment to end of line
        const nlIdx = body.indexOf('\n', pos);
        pos = nlIdx === -1 ? body.length : nlIdx + 1;
        currentName = '';
        continue;
      }
      if (char !== ' ' && char !== '\n' && char !== '\t' && char !== ';') {
        currentName += char;
      }
      pos++;
    } else {
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth < 0) {
          // End of with rec block or stray } — trim whitespace only,
          // do not strip } from the body as it may belong to attrset syntax.
          currentBody = currentBody.trim();
          break;
        }
      }
      currentBody += char;
      pos++;
      // Assignment ends with ; at depth 0
      if (char === ';' && depth === 0) {
        // Only strip the trailing ; (assignment terminator).
        // Do NOT strip } — it belongs to attrset/function-call syntax
        // (e.g. "import ./nix/packages.nix { inherit pkgs; }") and must be
        // preserved for callers inspecting the parsed assignment body.
        let body = currentBody.trim();
        body = body.replace(/\s*;\s*$/, '');
        assignments.push({
          name: currentName.trim(),
          body,
        });
        currentName = '';
        currentBody = '';
        depth = 0;
        inAssignment = false;
      }
    }
  }

  // Handle last assignment without trailing semicolon check
  if (currentName.trim() && currentBody.trim()) {
    // Only strip trailing ; (assignment terminator), not }
    let body = currentBody.trim();
    body = body.replace(/\s*;\s*$/, '');
    assignments.push({
      name: currentName.trim(),
      body,
    });
  }

  return assignments;
}

function parseFinalInheritIds(content: string): string[] {
  // Find the final { inherit ... ; } block — it's after the "with rec { ... };" block
  const withRecMatch = content.match(/with\s+rec\s*\{/);
  if (!withRecMatch) return [];

  const braceStart = withRecMatch.index! + withRecMatch[0].length;
  const closingIdx = findMatchingBrace(content, braceStart);
  if (closingIdx === -1) return [];

  // After the with rec block's closing }, find { inherit ... ; }
  const afterRec = content.slice(closingIdx);
  const inheritMatch = afterRec.match(/\{\s*inherit\s+([^;]+);\s*\}/);
  if (!inheritMatch) return [];

  return inheritMatch[1].trim().split(/\s+/);
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

function findBracedRegion(
  content: string,
  pattern: RegExp,
): BracedRegion | null {
  const match = content.match(pattern);
  if (!match) return null;

  const relativeOpen = match[0].lastIndexOf('{');
  const open = match.index! + relativeOpen;
  const close = findMatchingBrace(content, open + 1);
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

  const withRecRegion = findBracedRegion(content, /with\s+rec\s*\{/);
  if (!withRecRegion)
    throw new Error('Cannot merge flake.nix: with rec block was not found');

  const withRecBody = content.slice(
    withRecRegion.open + 1,
    withRecRegion.close,
  );
  const packagesMatch = withRecBody.match(/\bpackages\s*=\s*import\b/);
  if (!packagesMatch) return content;

  const packagesStart = withRecRegion.open + 1 + packagesMatch.index!;
  const argsOpen = content.indexOf(
    '{',
    packagesStart + packagesMatch[0].length,
  );
  if (argsOpen === -1 || argsOpen >= withRecRegion.close) {
    throw new Error(
      'Cannot merge flake.nix: packages import argument set was not found',
    );
  }

  const argsClose = findMatchingBrace(content, argsOpen + 1);
  if (argsClose === -1 || argsClose > withRecRegion.close) {
    throw new Error(
      'Cannot merge flake.nix: packages import argument set is unbalanced',
    );
  }

  const argsBody = content.slice(argsOpen + 1, argsClose);
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
  const inheritText = inheritMatch[1];
  if (!inheritText.includes('\n')) {
    return (
      content.slice(0, semicolon) +
      ' ' +
      missing.join(' ') +
      content.slice(semicolon)
    );
  }

  const semicolonLineStart = content.lastIndexOf('\n', semicolon) + 1;
  const beforeSemicolon = content.slice(semicolonLineStart, semicolon);
  if (/^\s*$/.test(beforeSemicolon)) {
    const indent = beforeSemicolon;
    const block = missing.map((id) => indent + id).join('\n');
    return (
      content.slice(0, semicolonLineStart) +
      block +
      '\n' +
      content.slice(semicolonLineStart)
    );
  }

  return (
    content.slice(0, semicolon) +
    ' ' +
    missing.join(' ') +
    content.slice(semicolon)
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
  content = insertMissingPackageInherits(content, [...allPackageInherits]);
  assertMergeInvariants(content, mergedInputs, mergedOutputParams);
  return content;
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
