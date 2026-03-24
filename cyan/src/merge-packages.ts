// merge-packages.ts — Parser, merger, and pretty-printer for packages.nix files

interface InheritIdentifier {
  id: string;
  comment?: string;
}

interface SubBlockEntry {
  type: 'inherit' | 'assignment';
  // For inherit: list of identifiers with optional comments
  identifiers?: InheritIdentifier[];
  // For assignment: optional comment before the assignment
  comment?: string;
  name?: string;
  value?: string;
}

interface SubBlock {
  name: string;
  withRegistry: string | null;
  hasRec: boolean;
  entries: SubBlockEntry[];
}

interface ParsedPackages {
  functionArgs: string[];
  subBlocks: Map<string, SubBlock>;
  mergeLine: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findMatching(text: string, openChar: string, closeChar: string, openIdx: number): number {
  // openIdx points to the opening bracket. Start scanning after it.
  let depth = 1;
  let i = openIdx + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === openChar) depth++;
    else if (text[i] === closeChar) depth--;
    if (depth === 0) return i;
    i++;
  }
  return -1;
}

// ─── Parse ───────────────────────────────────────────────────────────────────

function parsePackages(content: string): ParsedPackages {
  const lines = content.split('\n');

  // 1. Extract function args: { pkgs, pkgs-2505, atomi }:
  let functionArgs: string[] = [];
  let lineIdx = 0;

  const argsMatch = lines[0]?.match(/^\s*\{([^}]+)\}\s*:\s*$/);
  if (argsMatch) {
    functionArgs = argsMatch[1].split(',').map((a) => a.trim()).filter(Boolean);
    lineIdx = 1;
  }

  // 2. Find `let` line
  for (let i = lineIdx; i < lines.length; i++) {
    if (lines[i].trim() === 'let') {
      lineIdx = i + 1;
      break;
    }
  }

  // 3. Find `all = rec {` and extract the outer block content
  const subBlocks = new Map<string, SubBlock>();

  const allMatch = content.indexOf('all = rec {');
  if (allMatch !== -1) {
    const braceStart = allMatch + 'all = rec '.length; // position of '{'
    const closingIdx = findMatching(content, '{', '}', braceStart);

    if (closingIdx !== -1) {
      const outerBody = content.slice(braceStart + 1, closingIdx);
      parseSubBlocks(outerBody, subBlocks);
    }
  }

  // 4. Parse final merge line after `in`
  // Find the `in` keyword that follows the `let` block.
  // It appears as a standalone line or as `\nin` followed by a newline or space.
  let mergeLine: string[] = [];
  // Look for `\nin\n` or `\nin ` pattern (the `let ... in` keyword)
  const inRegex = /\bin\s*\n/gs;
  const inMatches = [...content.matchAll(inRegex)];
  // Take the last match which should be the top-level `in`
  let afterIn = '';
  if (inMatches.length > 0) {
    const lastMatch = inMatches[inMatches.length - 1];
    afterIn = content.slice(lastMatch.index! + lastMatch[0].length).trim();
  }

  if (afterIn) {
    // Split into lines, skip "with all;" line, collect block names from // expressions
    for (const line of afterIn.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('with ') && trimmed.endsWith(';')) continue;
      // Split by // to get individual block names
      const parts = trimmed.split('//');
      for (const part of parts) {
        const name = part.trim();
        if (name) mergeLine.push(name);
      }
    }
  }

  return { functionArgs, subBlocks, mergeLine };
}

function parseSubBlocks(outerBody: string, subBlocks: Map<string, SubBlock>) {
  // Find each sub-block: name = ( ... );
  // We look for patterns like: name = (\n    with registry;\n    rec { ... }\n  );
  let pos = 0;

  while (pos < outerBody.length) {
    // Skip whitespace/newlines
    while (pos < outerBody.length && /\s/.test(outerBody[pos])) pos++;
    if (pos >= outerBody.length) break;

    // Try to match: name = (
    const match = outerBody.slice(pos).match(/^([\w-]+)\s*=\s*\(/);
    if (!match) {
      pos++;
      continue;
    }

    const blockName = match[1];
    pos += match[0].length;

    // Now we're inside the parenthesized block.
    // Find the matching closing paren.
    const parenClose = findMatching(outerBody, '(', ')', pos - 1);
    if (parenClose === -1) break;

    const parenBody = outerBody.slice(pos, parenClose).trim();
    pos = parenClose + 1;

    // Skip past the trailing ; and whitespace
    while (pos < outerBody.length && outerBody[pos] === ';') pos++;

    // Parse the paren body
    let withRegistry: string | null = null;
    let hasRec = false;
    let innerBraceOpen = -1;
    let innerBraceClose = -1;

    // Check for `with <registry>;`
    const withMatch = parenBody.match(/^with\s+([\w-]+)\s*;/);
    if (withMatch) {
      withRegistry = withMatch[1];
    }

    // Check for `rec {`
    const recIdx = parenBody.indexOf('rec {');
    const plainBraceIdx = parenBody.indexOf('{');

    if (recIdx !== -1) {
      hasRec = true;
      innerBraceOpen = recIdx + 4; // position of '{' in 'rec {'
    } else if (plainBraceIdx !== -1) {
      innerBraceOpen = plainBraceIdx; // position of '{'
    }

    if (innerBraceOpen !== -1) {
      innerBraceClose = findMatching(parenBody, '{', '}', innerBraceOpen);
    }

    const entries: SubBlockEntry[] = [];

    if (innerBraceOpen !== -1 && innerBraceClose !== -1) {
      const innerBody = parenBody.slice(innerBraceOpen + 1, innerBraceClose);
      parseEntries(innerBody, entries);
    }

    subBlocks.set(blockName, { name: blockName, withRegistry, hasRec, entries });
  }
}

function parseEntries(innerBody: string, entries: SubBlockEntry[]) {
  // Parse entries from the inner block body.
  // Entries are:
  //   - Multi-line inherit: inherit\n  id1\n  id2\n  ;
  //   - Single-line inherit: inherit id1 id2;
  //   - Assignment: name = value;  (value can span multiple lines with balanced braces)
  // Comments (# to end of line) are captured and associated with the next identifier or assignment.
  let pos = 0;
  let pendingComment: string | undefined;

  while (pos < innerBody.length) {
    // Skip whitespace
    while (pos < innerBody.length && /\s/.test(innerBody[pos])) pos++;
    if (pos >= innerBody.length) break;

    // Try to match 'inherit' keyword
    if (innerBody.slice(pos).startsWith('inherit')) {
      pos += 7;

      // Check if multi-line inherit (next non-whitespace is an identifier, not followed by ; on same line)
      // or single-line inherit (identifiers followed by ; on same line)
      // Skip whitespace after 'inherit'
      let wsEnd = pos;
      while (wsEnd < innerBody.length && innerBody[wsEnd] === ' ' || innerBody[wsEnd] === '\t') wsEnd++;

      // Look ahead: if we find a ; before any newline, it's single-line
      let semiPos = -1;
      let newlinePos = -1;
      for (let i = wsEnd; i < innerBody.length; i++) {
        if (innerBody[i] === '\n' && newlinePos === -1) newlinePos = i;
        if (innerBody[i] === ';') { semiPos = i; break; }
        if (innerBody[i] === '}') break;
      }

      if (semiPos !== -1 && (newlinePos === -1 || semiPos < newlinePos)) {
        // Single-line inherit: inherit id1 id2 id3;
        const idStr = innerBody.slice(wsEnd, semiPos).trim();
        const ids = idStr.split(/\s+/).filter((id) => id.length > 0 && !id.startsWith('#'));
        entries.push({ type: 'inherit', identifiers: ids.map((id) => ({ id })) });
        pendingComment = undefined;
        pos = semiPos + 1;
      } else {
        // Multi-line inherit: inherit\n  id1\n  id2\n;
        const ids: InheritIdentifier[] = [];
        // Read identifiers until we find ;
        while (pos < innerBody.length) {
          // Skip whitespace
          while (pos < innerBody.length && /\s/.test(innerBody[pos])) pos++;
          if (pos >= innerBody.length) break;

          if (innerBody[pos] === ';') {
            pos++;
            break;
          }

          if (innerBody[pos] === '}') break;

          // Capture comments: # to end of line — associate with next identifier
          if (innerBody[pos] === '#') {
            let commentStart = pos;
            while (pos < innerBody.length && innerBody[pos] !== '\n') pos++;
            pendingComment = innerBody.slice(commentStart, pos).trim();
            continue;
          }

          // Read identifier until whitespace or ;
          let idStart = pos;
          while (pos < innerBody.length && !/\s/.test(innerBody[pos]) && innerBody[pos] !== ';' && innerBody[pos] !== '#') pos++;
          const id = innerBody.slice(idStart, pos);
          // Strip inline comments
          const commentIdx = id.indexOf('#');
          const cleanId = commentIdx > 0 ? id.slice(0, commentIdx).trim() : id;
          if (cleanId && !cleanId.startsWith('#')) {
            ids.push({ id: cleanId, comment: pendingComment });
            pendingComment = undefined;
          }
        }
        entries.push({ type: 'inherit', identifiers: ids });
      }
      continue;
    }

    // Try to match assignment: name = value;
    const assignMatch = innerBody.slice(pos).match(/^([\w-]+)\s*=\s*/);
    if (assignMatch) {
      const name = assignMatch[1];
      pos += assignMatch[0].length;

      // Read value until ; at depth 0
      let valueStart = pos;
      let depth = 0;

      while (pos < innerBody.length) {
        const ch = innerBody[pos];
        if (ch === '{' || ch === '(') depth++;
        else if (ch === '}' || ch === ')') {
          if (depth === 0) break; // End of block
          depth--;
        }
        if (ch === ';' && depth === 0) break;
        pos++;
      }

      const value = innerBody.slice(valueStart, pos).trim();
      if (value.endsWith(';')) {
        // Won't happen since we stop at ';'
      }
      pos++; // skip past ;

      entries.push({ type: 'assignment', name, value, comment: pendingComment });
      pendingComment = undefined;
      continue;
    }

    // Skip unrecognized characters
    pos++;
  }
}

// ─── Merge ───────────────────────────────────────────────────────────────────

export function mergePackages(
  sortedFiles: { content: string; layer: number; template: string }[],
): string {
  const parsed = sortedFiles.map((f) => parsePackages(f.content));

  // Function args: concat all, dedupe, sort
  const allArgs = new Set<string>();
  for (const p of parsed) {
    for (const arg of p.functionArgs) {
      allArgs.add(arg);
    }
  }
  const functionArgs = [...allArgs].sort();

  // Sub-blocks: merge by name
  const mergedBlocks = new Map<string, SubBlock>();
  // Track inherit identifiers per sub-block for LWW merge
  const inheritIdMaps = new Map<string, Map<string, InheritIdentifier>>();

  for (const p of parsed) {
    for (const [name, block] of p.subBlocks) {
      if (!mergedBlocks.has(name)) {
        mergedBlocks.set(name, {
          name,
          withRegistry: block.withRegistry,
          hasRec: block.hasRec,
          entries: [],
        });
      }

      const existing = mergedBlocks.get(name)!;

      // withRegistry: first non-null wins
      if (block.withRegistry !== null && existing.withRegistry === null) {
        existing.withRegistry = block.withRegistry;
      }

      // hasRec: if any uses rec, include it
      if (block.hasRec) {
        existing.hasRec = true;
      }

      // Initialize inherit map for this sub-block
      if (!inheritIdMaps.has(name)) inheritIdMaps.set(name, new Map());
      const inheritMap = inheritIdMaps.get(name)!;

      // Merge entries
      for (const entry of block.entries) {
        if (entry.type === 'inherit') {
          // LWW by identifier: highest layer's version (including comment) wins
          for (const ident of entry.identifiers ?? []) {
            inheritMap.set(ident.id, ident);
          }
        } else if (entry.type === 'assignment' && entry.name) {
          // Named assignments: LWW by LHS key name
          const existingIdx = existing.entries.findIndex(
            (e) => e.type === 'assignment' && e.name === entry.name,
          );
          if (existingIdx >= 0) {
            existing.entries[existingIdx] = entry;
          } else {
            existing.entries.push(entry);
          }
        }
      }
    }
  }

  // Post-process: convert inherit maps to sorted entries
  for (const [name, inheritMap] of inheritIdMaps) {
    const block = mergedBlocks.get(name);
    if (block && inheritMap.size > 0) {
      const sorted = [...inheritMap.values()].sort((a, b) => a.id.localeCompare(b.id));
      block.entries.push({ type: 'inherit', identifiers: sorted });
    }
  }

  // Merge line: concat sub-block names, dedupe, sort
  const mergeNames = new Set<string>();
  for (const p of parsed) {
    for (const name of p.mergeLine) {
      mergeNames.add(name);
    }
  }
  const mergeLine = [...mergeNames].sort();

  return prettyPrint(functionArgs, mergedBlocks, mergeLine);
}

// ─── Pretty Print ────────────────────────────────────────────────────────────

function prettyPrint(
  functionArgs: string[],
  subBlocks: Map<string, SubBlock>,
  mergeLine: string[],
): string {
  const lines: string[] = [];

  // Function args sorted alphabetically
  lines.push(`{ ${functionArgs.join(', ')} }:`);
  lines.push('let');
  lines.push('  all = rec {');

  // Sub-blocks sorted alphabetically
  const sortedBlockNames = [...subBlocks.keys()].sort();

  for (let bi = 0; bi < sortedBlockNames.length; bi++) {
    const blockName = sortedBlockNames[bi];
    const block = subBlocks.get(blockName)!;

    // Blank line between sub-blocks
    if (bi > 0) {
      lines.push('');
    }

    // Separate assignments from inherits
    const assignments = block.entries.filter((e) => e.type === 'assignment');
    const inherits = block.entries.filter((e) => e.type === 'inherit');

    // Collect inherit identifiers (deduplicated by id, sorted)
    const inheritIdMap = new Map<string, InheritIdentifier>();
    for (const inh of inherits) {
      for (const ident of inh.identifiers ?? []) {
        inheritIdMap.set(ident.id, ident);
      }
    }
    const sortedInheritIds = [...inheritIdMap.values()].sort((a, b) => a.id.localeCompare(b.id));

    // Block opening
    lines.push(`    ${blockName} = (`);

    if (block.withRegistry) {
      lines.push(`      with ${block.withRegistry};`);
    }

    if (block.hasRec) {
      lines.push('      rec {');
    } else {
      lines.push('      {');
    }

    // Assignments first
    for (let ai = 0; ai < assignments.length; ai++) {
      if (ai > 0) {
        lines.push('');
      }

      // Print comment before assignment if present
      if (assignments[ai].comment) {
        lines.push(`        ${assignments[ai].comment}`);
      }

      // Format the value
      const valueLines = formatAssignmentValue(assignments[ai].name!, assignments[ai].value!);
      for (const vl of valueLines) {
        lines.push('        ' + vl);
      }
    }

    // Inherit block
    if (sortedInheritIds.length > 0) {
      // Blank line between assignments and inherit
      if (assignments.length > 0) {
        lines.push('');
      }

      lines.push('        inherit');
      for (const ident of sortedInheritIds) {
        if (ident.comment) {
          lines.push('');
          lines.push(`          ${ident.comment}`);
        }
        lines.push(`          ${ident.id}`);
      }
      lines.push('        ;');
    }

    // Block closing
    lines.push('      }');

    // Closing paren
    lines.push('    );');
  }

  lines.push('  };');
  lines.push('in');
  lines.push('with all;');

  // Final merge line
  for (let mi = 0; mi < mergeLine.length; mi++) {
    if (mi === mergeLine.length - 1) {
      lines.push(mergeLine[mi]);
    } else {
      lines.push(`${mergeLine[mi]} //`);
    }
  }

  lines.push('');

  return lines.join('\n');
}

function formatAssignmentValue(name: string, value: string): string[] {
  const trimmed = value.trim();

  if (!trimmed.includes('\n')) {
    return [`${name} = ${trimmed};`];
  }

  // Multi-line value
  const valueLines = trimmed.split('\n');
  const result: string[] = [`${name} = ${valueLines[0]}`];
  for (let i = 1; i < valueLines.length - 1; i++) {
    result.push(valueLines[i]);
  }
  result.push(`${valueLines[valueLines.length - 1]};`);
  return result;
}
