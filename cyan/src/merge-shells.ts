// merge-shells.ts — Parser, merger, and pretty-printer for shells.nix files

interface ParsedShell {
  buildInputs: string[];
}

interface ParsedShells {
  functionArgs: string[];
  withEnv: boolean;
  shells: Map<string, ParsedShell>;
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

// ─── Parse ───────────────────────────────────────────────────────────────────

function parseShells(content: string): ParsedShells {
  const lines = content.split('\n');

  // 1. Extract function args: { pkgs, packages, env, shellHook }:
  let functionArgs: string[] = [];
  let lineIdx = 0;

  const argsMatch = lines[0]?.match(/^\s*\{([^}]+)\}\s*:\s*$/);
  if (argsMatch) {
    functionArgs = argsMatch[1].split(',').map((a) => a.trim()).filter(Boolean);
    lineIdx = 1;
  }

  // 2. Detect `with env;` line
  let withEnv = false;
  if (lineIdx < lines.length) {
    const withMatch = lines[lineIdx].match(/^\s*with\s+env\s*;\s*$/);
    if (withMatch) {
      withEnv = true;
      lineIdx++;
    }
  }

  // 3. Parse top-level attrset — each key is a shell name
  const shells = new Map<string, ParsedShell>();
  let inAttrset = false;
  let currentShell: string | null = null;
  let currentBuildInputs: string[] = [];
  let inMkShell = false;
  let mkShellDepth = 0;

  for (let i = lineIdx; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Opening brace of top-level attrset
    if (trimmed === '{') {
      inAttrset = true;
      continue;
    }

    // Closing brace of top-level attrset
    if (trimmed === '}') {
      if (inAttrset && currentShell !== null) {
        shells.set(currentShell, { buildInputs: currentBuildInputs });
        currentShell = null;
        currentBuildInputs = [];
      }
      break;
    }

    if (!inAttrset) continue;

    // Shell assignment: name = pkgs.mkShell {
    const shellMatch = trimmed.match(/^([\w-]+)\s*=\s*pkgs\.mkShell\s*\{/);
    if (shellMatch) {
      if (currentShell !== null) {
        shells.set(currentShell, { buildInputs: currentBuildInputs });
      }
      currentShell = shellMatch[1];
      currentBuildInputs = [];
      inMkShell = true;
      mkShellDepth = 1;
      continue;
    }

    // Inside mkShell block
    if (inMkShell && currentShell) {
      // Track brace depth
      for (const ch of trimmed) {
        if (ch === '{') mkShellDepth++;
        else if (ch === '}') mkShellDepth--;
      }

      // buildInputs = ...;
      const buildInputsMatch = trimmed.match(/^buildInputs\s*=\s*(.+);\s*$/);
      if (buildInputsMatch) {
        const rhs = buildInputsMatch[1];
        // Split on ++ and collect identifiers
        const parts = rhs.split('++').map((p) => p.trim()).filter(Boolean);
        currentBuildInputs.push(...parts);
      }

      // inherit shellHook; — expected, skip
      if (trimmed.match(/^inherit\s+shellHook\s*;/)) continue;

      // Any other line inside mkShell that's not buildInputs or inherit shellHook → unknown field
      if (trimmed && !trimmed.startsWith('#') && !buildInputsMatch && !trimmed.match(/^inherit\s+shellHook\s*;/)) {
        // Only flag if we're at the right depth (inside the mkShell block, not closing it)
        if (mkShellDepth > 0 && trimmed !== '}') {
          throw new Error(
            `shells.nix: unknown field "${trimmed.split(/[=;]/)[0].trim()}" inside shell "${currentShell}" — only "buildInputs" and "inherit shellHook;" are allowed`,
          );
        }
      }

      // End of mkShell block
      if (mkShellDepth <= 0) {
        inMkShell = false;
      }
      continue;
    }
  }

  return { functionArgs, withEnv, shells };
}

// ─── Merge ───────────────────────────────────────────────────────────────────

export function mergeShells(
  sortedFiles: { content: string; layer: number; template: string }[],
): string {
  if (sortedFiles.length === 0) {
    throw new Error('shells.nix merge requires at least one input file');
  }
  const parsed = sortedFiles.map((f) => parseShells(f.content));

  // Function args: exact match — fail if different
  const firstArgs = [...parsed[0].functionArgs].sort();
  for (const p of parsed) {
    const pArgs = [...p.functionArgs].sort();
    if (pArgs.length !== firstArgs.length || !pArgs.every((a, i) => a === firstArgs[i])) {
      throw new Error(
        `shells.nix function args mismatch: "[${p.functionArgs.join(', ')}]" vs "[${parsed[0].functionArgs.join(', ')}]"`,
      );
    }
  }

  // with env; must be consistent across all inputs
  const firstWithEnv = parsed[0].withEnv;
  for (const p of parsed) {
    if (p.withEnv !== firstWithEnv) {
      throw new Error(
        'shells.nix "with env;" presence mismatch across inputs',
      );
    }
  }

  // Merge shells: for each shell name, concat buildInputs, dedupe, sort
  const mergedShells = new Map<string, Set<string>>();

  for (const p of parsed) {
    for (const [name, shell] of p.shells) {
      if (!mergedShells.has(name)) {
        mergedShells.set(name, new Set());
      }
      for (const input of shell.buildInputs) {
        mergedShells.get(name)!.add(input);
      }
    }
  }

  const hasShellHook = parsed[0].functionArgs.includes('shellHook');
  return prettyPrint(parsed[0].functionArgs, firstWithEnv, mergedShells, hasShellHook);
}

// ─── Pretty Print ────────────────────────────────────────────────────────────

function prettyPrint(
  functionArgs: string[],
  withEnv: boolean,
  shells: Map<string, Set<string>>,
  hasShellHook: boolean,
): string {
  const lines: string[] = [];

  // Function args sorted alphabetically, with "..." at the end
  const rest = functionArgs.filter((a) => a === '...');
  const namedArgs = functionArgs.filter((a) => a !== '...').sort();
  const sortedArgs = [...namedArgs, ...rest];
  lines.push(`{ ${sortedArgs.join(', ')} }:`);
  if (withEnv) {
    lines.push('with env;');
  }

  // Opening brace
  lines.push('{');

  // Shells sorted alphabetically
  const sortedShellNames = [...shells.keys()].sort();

  for (let si = 0; si < sortedShellNames.length; si++) {
    const shellName = sortedShellNames[si];
    const buildInputs = [...shells.get(shellName)!].sort();

    // Blank line between shells (not before first)
    if (si > 0) {
      lines.push('');
    }

    lines.push(`  ${shellName} = pkgs.mkShell {`);
    lines.push(`    buildInputs = ${buildInputs.length === 0 ? '[]' : buildInputs.join(' ++ ')};`);
    if (hasShellHook) {
      lines.push('    inherit shellHook;');
    }
    lines.push('  };');
  }

  // Closing brace + trailing newline
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}
