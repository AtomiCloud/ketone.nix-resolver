// merge-shells.ts — Parser, merger, and pretty-printer for shells.nix files
//
// The line-oriented parser this replaced modelled a shells.nix as: line 0 is the whole
// function head, line 1 may be `with env;`, and everything after that is scanned with
// `trimmed === '{'` tests. A canonical treefmt-formatted file breaks every one of those
// assumptions at once — the head spans five lines, so `functionArgs` came back empty, the
// prelude check looked at `pkgs,` instead of `with env;`, and `hasShellHook` (derived from
// the empty argument list) was false. The merger emitted
//
//     {  }:
//     {
//       cd = pkgs.mkShell { buildInputs = main ++ system; };
//       ...
//     }
//
// with no head, no prelude and no `inherit shellHook;` — a file that cannot evaluate — and
// exited success. Everything below scans structurally over brace/paren depth with comments
// and string literals masked out, and refuses on any shape it cannot account for.

import { findFunctionHeader, maskNixTrivia } from './loss-guard.ts';

interface ParsedShell {
  buildInputs: string[];
  /** Identifiers pulled in by `inherit ...;` inside the shell, e.g. `shellHook`. */
  inherits: string[];
}

interface ParsedShells {
  functionArgs: string[];
  hasEllipsis: boolean;
  /** `with X;` preludes between the head and the attrset, in source order. */
  preludes: string[];
  shells: Map<string, ParsedShell>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** `open` points at the opening brace; returns the index of its match, or -1. */
function matchingBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipWhitespace(code: string, pos: number): number {
  let i = pos;
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

/** Index of the `;` that terminates the entry starting at `pos`, at bracket depth 0. */
function entryTerminator(code: string, pos: number, limit: number): number {
  let depth = 0;
  for (let i = pos; i < limit; i++) {
    const ch = code[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      if (depth === 0) return -1;
      depth--;
    } else if (ch === ';' && depth === 0) return i;
  }
  return -1;
}

function refuse(detail: string): never {
  throw new Error(`Cannot merge nix/shells.nix: ${detail}`);
}

// ─── Parse ───────────────────────────────────────────────────────────────────

function parseShells(content: string): ParsedShells {
  // Comments and string literals are blanked out at identical offsets, so every scan
  // below can use `code` for structure and `content` for the bytes it keeps.
  const code = maskNixTrivia(content);

  const header = findFunctionHeader(content);
  if (!header) {
    refuse(
      'no function argument set was found. The file must begin with a `{ ... }:` head ' +
        '(single-line or multi-line); refusing rather than emitting a headless skeleton.',
    );
  }

  // `with env;` — and any other prelude — sits between the head and the attrset.
  const preludes: string[] = [];
  let pos = skipWhitespace(code, header.colonIndex + 1);
  for (;;) {
    const match = code.slice(pos).match(/^with\s+([a-zA-Z_][\w'-]*)\s*;/);
    if (!match) break;
    preludes.push(match[1]);
    pos = skipWhitespace(code, pos + match[0].length);
  }

  if (code[pos] !== '{') {
    refuse(
      'the top-level shell attribute set was not found after the function head. ' +
        'Expected `{ <name> = pkgs.mkShell { ... }; ... }`; refusing rather than emitting ' +
        'an empty skeleton.',
    );
  }
  const attrsetOpen = pos;
  const attrsetClose = matchingBrace(code, attrsetOpen);
  if (attrsetClose === -1) {
    refuse('the top-level shell attribute set is unbalanced — its closing brace was not found.');
  }

  const shells = new Map<string, ParsedShell>();
  let cursor = skipWhitespace(code, attrsetOpen + 1);

  while (cursor < attrsetClose) {
    const rest = code.slice(cursor, attrsetClose);
    const shellMatch = rest.match(/^([\w-]+)\s*=\s*pkgs\.mkShell\s*\{/);
    if (!shellMatch) {
      const offender = content.slice(cursor, Math.min(cursor + 60, attrsetClose)).trim().split('\n')[0];
      refuse(
        `unrecognised entry "${offender}" in the top-level attribute set. Every entry must ` +
          'be `<name> = pkgs.mkShell { ... };`; refusing rather than dropping it.',
      );
    }

    const name = shellMatch[1];
    const bodyOpen = cursor + shellMatch[0].length - 1;
    const bodyClose = matchingBrace(code, bodyOpen);
    if (bodyClose === -1 || bodyClose > attrsetClose) {
      refuse(`shell "${name}" has an unbalanced \`pkgs.mkShell { ... }\` block.`);
    }

    shells.set(name, parseShellBody(content, code, bodyOpen + 1, bodyClose, name));

    cursor = skipWhitespace(code, bodyClose + 1);
    if (code[cursor] !== ';') {
      refuse(`shell "${name}" is not terminated by a \`;\` after its \`pkgs.mkShell\` block.`);
    }
    cursor = skipWhitespace(code, cursor + 1);
  }

  if (shells.size === 0) {
    refuse(
      'the top-level attribute set declares no shells. Refusing rather than emitting an ' +
        'empty skeleton that silently drops every dev shell.',
    );
  }

  return { functionArgs: [...header.args], hasEllipsis: header.hasEllipsis, preludes, shells };
}

function parseShellBody(
  content: string,
  code: string,
  start: number,
  limit: number,
  name: string,
): ParsedShell {
  const buildInputs: string[] = [];
  const inherits: string[] = [];
  let cursor = skipWhitespace(code, start);

  while (cursor < limit) {
    const terminator = entryTerminator(code, cursor, limit);
    if (terminator === -1) {
      refuse(`an entry inside shell "${name}" is not terminated by a \`;\`.`);
    }
    const entry = content.slice(cursor, terminator);
    const entryCode = code.slice(cursor, terminator);

    const inheritMatch = entryCode.match(/^inherit\b([\s\S]*)$/);
    if (inheritMatch) {
      if (inheritMatch[1].trimStart().startsWith('(')) {
        // `inherit (src) a b;` binds a/b from `src`, not from the enclosing scope.
        // Unioning those identifiers with plain inherits would silently change where
        // they resolve from, so refuse rather than mangle a shape we do not model.
        refuse(
          `shell "${name}" uses \`inherit (<source>) ...;\`, which this merger does not ` +
            'model. Refusing rather than re-scoping the inherited names.',
        );
      }
      // `inherit shellHook;` — and any other inherited binding — must survive verbatim.
      // The old parser matched only the literal `inherit shellHook;` and re-derived it
      // from the (empty) argument list, so it was dropped whenever the head failed to
      // parse. Collect the identifiers instead.
      for (const identifier of inheritMatch[1].match(/[a-zA-Z_][\w'-]*/g) ?? []) {
        if (!inherits.includes(identifier)) inherits.push(identifier);
      }
    } else {
      const assignment = entryCode.match(/^([\w-]+)\s*=\s*/);
      if (!assignment) {
        refuse(`unrecognised entry "${entry.trim().split('\n')[0]}" inside shell "${name}".`);
      }
      if (assignment[1] !== 'buildInputs') {
        refuse(
          `unknown field "${assignment[1]}" inside shell "${name}" — only "buildInputs" and ` +
            '`inherit ...;` are modelled. Refusing rather than dropping it from the merged output.',
        );
      }
      const rhs = entry.slice(assignment[0].length).trim();
      for (const part of rhs.split('++').map((p) => p.trim()).filter(Boolean)) {
        buildInputs.push(part);
      }
    }

    cursor = skipWhitespace(code, terminator + 1);
  }

  return { buildInputs, inherits };
}

// ─── Merge ───────────────────────────────────────────────────────────────────

export function mergeShells(
  sortedFiles: { content: string; layer: number; template: string }[],
): string {
  if (sortedFiles.length === 0) {
    refuse('no files were provided; at least one is required.');
  }
  const parsed = sortedFiles.map((f) => parseShells(f.content));

  // Function args: exact match once normalised. Unioning them would be worse than
  // refusing — flake.nix calls this file with a fixed argument set, so an argument no
  // caller supplies is an evaluation error rather than a merge.
  const signature = (p: ParsedShells): string =>
    `{ ${[...p.functionArgs].sort().join(', ')}${p.hasEllipsis ? ', ...' : ''} }`;
  const firstSignature = signature(parsed[0]);
  for (const p of parsed) {
    if (signature(p) !== firstSignature) {
      refuse(`function args mismatch: "${signature(p)}" vs "${firstSignature}"`);
    }
  }

  // Preludes must agree too: `with env;` changes what every unqualified name in the file
  // resolves to, so merging a file that has it with one that does not is not well-defined.
  const firstPreludes = parsed[0].preludes.join(', ');
  for (const p of parsed) {
    if (p.preludes.join(', ') !== firstPreludes) {
      refuse(
        `prelude mismatch across inputs: "${p.preludes.map((w) => `with ${w};`).join(' ') || '(none)'}" ` +
          `vs "${parsed[0].preludes.map((w) => `with ${w};`).join(' ') || '(none)'}"`,
      );
    }
  }

  // Merge shells: per shell name, union buildInputs and union inherited identifiers.
  const mergedInputs = new Map<string, Set<string>>();
  const mergedInherits = new Map<string, Set<string>>();

  for (const p of parsed) {
    for (const [name, shell] of p.shells) {
      if (!mergedInputs.has(name)) {
        mergedInputs.set(name, new Set());
        mergedInherits.set(name, new Set());
      }
      for (const input of shell.buildInputs) mergedInputs.get(name)!.add(input);
      for (const identifier of shell.inherits) mergedInherits.get(name)!.add(identifier);
    }
  }

  return prettyPrint(
    [...parsed[0].functionArgs].sort(),
    parsed[0].hasEllipsis,
    parsed[0].preludes,
    mergedInputs,
    mergedInherits,
  );
}

// ─── Pretty Print ────────────────────────────────────────────────────────────

function prettyPrint(
  functionArgs: string[],
  hasEllipsis: boolean,
  preludes: string[],
  shells: Map<string, Set<string>>,
  inherits: Map<string, Set<string>>,
): string {
  const lines: string[] = [];

  // Function args sorted alphabetically, with `...` last
  const headArgs = hasEllipsis ? [...functionArgs, '...'] : functionArgs;
  lines.push(`{ ${headArgs.join(', ')} }:`);
  for (const prelude of preludes) {
    lines.push(`with ${prelude};`);
  }

  lines.push('{');

  const sortedShellNames = [...shells.keys()].sort();

  for (let si = 0; si < sortedShellNames.length; si++) {
    const shellName = sortedShellNames[si];
    const buildInputs = [...shells.get(shellName)!].sort();
    const shellInherits = [...(inherits.get(shellName) ?? new Set<string>())].sort();

    // Blank line between shells (not before first)
    if (si > 0) {
      lines.push('');
    }

    lines.push(`  ${shellName} = pkgs.mkShell {`);
    lines.push(`    buildInputs = ${buildInputs.length === 0 ? '[]' : buildInputs.join(' ++ ')};`);
    if (shellInherits.length > 0) {
      lines.push(`    inherit ${shellInherits.join(' ')};`);
    }
    lines.push('  };');
  }

  // Closing brace + trailing newline
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}
