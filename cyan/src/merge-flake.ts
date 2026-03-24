// merge-flake.ts — Parser, merger, and pretty-printer for flake.nix files

interface InputEntry {
  name: string;
  url: string;
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
  inputGroups: CommentGroup[];
  outputParamGroups: CommentGroup[];
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

function findMatchingParen(text: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx;
  while (i < text.length && depth > 0) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    if (depth === 0) return i;
    i++;
  }
  return -1;
}

function stripLeadingCommas(s: string): string {
  return s.replace(/^[\s,]+/, '');
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

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '}') continue;

    if (trimmed.startsWith('#')) {
      currentGroup = { label: trimmed, items: [] };
      groups.push(currentGroup);
      continue;
    }

    const entryMatch = trimmed.match(/^([\w-]+)\.url\s*=\s*"([^"]+)"\s*;?\s*$/);
    if (entryMatch) {
      const entry = `${entryMatch[1]}.url = "${entryMatch[2]}";`;
      if (!currentGroup) {
        currentGroup = { label: '', items: [] };
        groups.push(currentGroup);
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
      const m = item.match(/^([\w-]+)\.url\s*=\s*"([^"]+)"\s*;?\s*$/);
      if (m) entries.push({ name: m[1], url: m[2] });
    }
  }
  return entries;
}

function parseOutputParams(content: string): CommentGroup[] {
  const match = content.match(/outputs\s*=\s*\{/);
  if (!match) return [];

  const braceStart = match.index! + match[0].length;
  // Find the closing } followed by @inputs:
  let depth = 1;
  let i = braceStart;
  while (i < content.length && depth > 0) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') depth--;
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0) return [];

  const body = content.slice(braceStart, i);
  const lines = body.split('\n');
  const groups: CommentGroup[] = [];
  let currentGroup: CommentGroup | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#')) {
      currentGroup = { label: trimmed, items: [] };
      groups.push(currentGroup);
      continue;
    }

    const name = stripLeadingCommas(trimmed);
    if (name && /^[a-zA-Z][\w-]*$/.test(name)) {
      if (!currentGroup) {
        currentGroup = { label: '', items: [] };
        groups.push(currentGroup);
      }
      currentGroup.items.push(name);
    }
  }

  return groups;
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
  // Match "let pkgs = ...; in" — the second let block
  // Return just the assignment "pkgs = pkgs-2511;" for pretty-printing inside the let block
  const matches = [...content.matchAll(/\blet\s+/g)];
  if (matches.length < 2) return null;

  const secondLetStart = matches[1].index! + matches[1][0].length;
  const afterSecond = content.slice(secondLetStart);

  const m = afterSecond.match(/^(pkgs\s*=\s*[^;]+;)\s*\bin\b/);
  return m ? m[1].trim() : null;
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

  for (const char of body) {
    if (!inAssignment) {
      if (char === '=' && currentName.trim()) {
        inAssignment = true;
        continue;
      }
      if (char !== ' ' && char !== '\n' && char !== '\t' && char !== ';') {
        currentName += char;
      }
    } else {
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth < 0) {
          // End of with rec block - strip trailing } and whitespace from body
          currentBody = currentBody.replace(/\s*}\s*$/, '').trim();
          break;
        }
      }
      currentBody += char;
      // Assignment ends with ; at depth 0
      if (char === ';' && depth === 0) {
        // Strip trailing semicolon and closing brace - handle both }; and }; order
        let body = currentBody.trim();
        body = body.replace(/(\s*;\s*}\s*$|\s*}\s*;\s*$)/, ''); // strip }; or };
        body = body.replace(/\s*}\s*$/, ''); // strip any remaining }
        body = body.replace(/\s*;\s*$/, ''); // strip any remaining ;
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
    let body = currentBody.trim();
    body = body.replace(/(\s*;\s*}\s*$|\s*}\s*;\s*$)/, ''); // strip }; or };
    body = body.replace(/\s*}\s*$/, '');
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

  const inputGroups = parseInputsBlock(content);
  const outputParamGroups = parseOutputParams(content);
  const registryLines = parseRegistryLines(content);
  const pkgsAlias = parsePkgsAlias(content);
  const withRecAssignments = parseWithRecAssignments(content);
  const finalInheritIds = parseFinalInheritIds(content);

  return {
    description,
    inputGroups,
    outputParamGroups,
    registryLines,
    pkgsAlias,
    withRecAssignments,
    finalInheritIds,
  };
}

// ─── Merge ───────────────────────────────────────────────────────────────────

export function mergeFlake(
  sortedFiles: { content: string; layer: number; template: string }[],
): string {
  const parsed = sortedFiles.map((f) => parseFlake(f.content));

  // LWW for description
  const description = parsed[parsed.length - 1].description;

  // Merge input entries
  const mergedInputs = mergeInputEntries(parsed);

  // Merge output params
  const mergedOutputParams = mergeOutputParams(parsed);

  // Merge registry lines
  const mergedRegistries = mergeRegistryLines(parsed);

  // LWW for pkgs alias
  const pkgsAlias = parsed[parsed.length - 1].pkgsAlias;

  // LWW for with rec assignments, but merge packages inherit identifiers
  const highestLayer = parsed[parsed.length - 1];
  const withRecAssignments = [...highestLayer.withRecAssignments];

  // Merge packages inherit across all layers
  const allPackageInherits = new Set<string>();
  for (const p of parsed) {
    for (const id of extractPackagesInheritIds(p.withRecAssignments)) {
      allPackageInherits.add(id);
    }
  }

  // Update the packages assignment's inherit identifiers
  if (allPackageInherits.size > 0) {
    const sortedInherits = [...allPackageInherits].sort();
    const pkgIdx = withRecAssignments.findIndex((a) => a.name === 'packages');
    if (pkgIdx >= 0) {
      const pkg = withRecAssignments[pkgIdx];
      const importPath = pkg.body.match(/import\s+([^\n{]+)/)?.[1].trim() ?? './nix/packages.nix';
      withRecAssignments[pkgIdx] = {
        name: 'packages',
        body: `import ${importPath}\n            {\n              inherit ${sortedInherits.join(' ')};\n            }`,
      };
    }
  }

  // LWW for final inherit
  const finalInheritIds = highestLayer.finalInheritIds;

  return prettyPrint({
    description,
    inputGroups: mergedInputs,
    outputParamGroups: mergedOutputParams,
    registryLines: mergedRegistries,
    pkgsAlias,
    withRecAssignments,
    finalInheritIds,
  });
}

function mergeInputEntries(parsed: ParsedFlake[]): CommentGroup[] {
  const urlByInput = new Map<string, string>();
  const inputToGroup = new Map<string, string>();

  for (const p of parsed) {
    const entries = parseInputEntries(p.inputGroups);
    for (const entry of entries) {
      urlByInput.set(entry.name, entry.url);
    }
    for (const group of p.inputGroups) {
      for (const item of group.items) {
        const name = item.match(/^([\w-]+)\./)?.[1];
        if (name && !inputToGroup.has(name)) {
          inputToGroup.set(name, group.label);
        }
      }
    }
  }

  // Build groups
  const groupMap = new Map<string, string[]>();
  for (const [name, url] of urlByInput) {
    const group = inputToGroup.get(name) ?? '';
    const entry = `    ${name}.url = "${url}";`;
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
        if (!paramToGroup.has(item)) {
          paramToGroup.set(item, group.label);
        }
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

// ─── Pretty Print ────────────────────────────────────────────────────────────

function formatAssignmentBody(name: string, body: string): string {
  if (name === 'packages') {
    // Special formatting for packages = import ... { inherit ...; };
    return body;
  }

  // For import assignments with multi-line blocks, preserve original indentation
  // The body from parser already has correct relative indentation
  const importMatch = body.match(/^import\s+(.+)$/s);
  if (importMatch) {
    const rest = importMatch[1].trim();

    // Check if it has a block argument { ... }
    if (rest.includes('{')) {
      // For multi-line bodies, return as-is to preserve original formatting
      // The closing } is already at the correct indentation
      return 'import ' + rest;
    }
    return 'import ' + rest;
  }

  // For checks = { ... } - inline blocks
  if (body.trim().startsWith('{')) {
    const inner = body.trim().slice(1, -1).trim();
    if (!inner) return '{ }';
    // Format inline
    const parts = inner.split(';').filter(p => p.trim());
    return '{ ' + parts.map(p => p.trim()).join('; ') + '; }';
  }

  return body;
}

function prettyPrint(flake: {
  description: string;
  inputGroups: CommentGroup[];
  outputParamGroups: CommentGroup[];
  registryLines: RegistryLine[];
  pkgsAlias: string | null;
  withRecAssignments: WithRecAssignment[];
  finalInheritIds: string[];
}): string {
  const lines: string[] = [];

  lines.push('{');
  lines.push(`  description = "${flake.description}";`);
  lines.push('');
  lines.push('  inputs = {');

  let firstGroup = true;
  for (const group of flake.inputGroups) {
    if (!firstGroup) lines.push('');
    firstGroup = false;
    if (group.label) lines.push(`    ${group.label}`);
    for (const item of group.items) {
      lines.push(item);
    }
  }

  lines.push('');
  lines.push('  };');
  lines.push('  outputs =');

  // Output params
  lines.push('    { self');
  for (const group of flake.outputParamGroups) {
    if (group.label) {
      lines.push('');
      lines.push(`      ${group.label}`);
    }
    for (const item of group.items) {
      if (item === 'self') continue;
      lines.push(`    , ${item}`);
    }
  }
  lines.push('');
  lines.push('    } @inputs:');

  lines.push('    (flake-utils.lib.eachDefaultSystem');
  lines.push('      (');
  lines.push('        system:');

  // Registry setup
  lines.push('        let');
  for (const reg of flake.registryLines) {
    lines.push(`          ${reg.name} = ${reg.expr};`);
  }
  // pkgs alias goes inside the let block before 'in'
  if (flake.pkgsAlias) {
    lines.push(`          ${flake.pkgsAlias}`);
  }
  lines.push('        in');
  lines.push('        ');

  // with rec block
  lines.push('        with rec {');
  for (const assignment of flake.withRecAssignments) {
    const formattedBody = formatAssignmentBody(assignment.name, assignment.body);
    lines.push(`          ${assignment.name} = ${formattedBody};`);
  }
  lines.push('        };');

  // Final output
  lines.push('        {');
  if (flake.finalInheritIds.length > 0) {
    lines.push(`          inherit ${flake.finalInheritIds.join(' ')};`);
  }
  lines.push('        }');

  // Close eachDefaultSystem
  lines.push('      )');
  lines.push('    )');
  lines.push('  ;');
  lines.push('');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}
