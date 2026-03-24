// merge-fmt.ts — Parser, merger, and pretty-printer for fmt.nix files

interface ProgramConfig {
  enable: boolean;
  extra_args?: string[];
  [key: string]: boolean | string[] | undefined;
}

interface ParsedFmt {
  functionArgs: string;
  projectRootFile: string;
  programs: Map<string, ProgramConfig>;
  tail: string; // the "in (treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper" part
  programsComment?: string; // comment above the programs = { line, if present
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeFunctionArgs(argsStr: string): string {
  // Parse function args like "{ pkgs, treefmt-nix, ... }" and sort them alphabetically
  // The args are inside the curly braces, separated by commas
  const match = argsStr.match(/^\{([^}]+)\}$/);
  if (!match) return argsStr; // Not a valid function args string, return as-is

  const argsContent = match[1];
  const args = argsContent.split(',').map((arg) => arg.trim());

  // Sort alphabetically, but keep "..." at the end if present
  const restIdx = args.indexOf('...');
  let sortedArgs: string[];
  if (restIdx !== -1) {
    const rest = args.splice(restIdx, 1);
    sortedArgs = [...args.sort(), ...rest];
  } else {
    sortedArgs = args.sort();
  }

  return `{ ${sortedArgs.join(', ')} }`;
}

function parseFmt(content: string): ParsedFmt {
  const lines = content.split('\n');

  // 1. Extract function args line — match ^{...}:
  let functionArgs = '';
  let lineIdx = 0;

  const argsMatch = lines[0]?.match(/^\s*(\{[^}]+\})\s*:\s*$/);
  if (argsMatch) {
    functionArgs = argsMatch[1];
    lineIdx = 1;
  }

  // 2. Skip `let` and find `fmt = {`
  let inFmtBlock = false;
  let fmtBlockStart = -1;
  let braceDepth = 0;

  for (let i = lineIdx; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!inFmtBlock) {
      if (trimmed === 'let') {
        // Find the next line with `fmt = {`
        for (let j = i + 1; j < lines.length; j++) {
          const nextTrimmed = lines[j].trim();
          const fmtMatch = nextTrimmed.match(/^fmt\s*=\s*\{/);
          if (fmtMatch) {
            inFmtBlock = true;
            fmtBlockStart = j;
            // The `{` is at the end of this line
            braceDepth = 1;
            lineIdx = j + 1;
            break;
          }
        }
        if (!inFmtBlock) break;
      }
    }

    if (fmtBlockStart !== -1 && i >= fmtBlockStart) {
      for (const char of lines[i]) {
        if (char === '{') braceDepth++;
        else if (char === '}') braceDepth--;
      }

      // Check if we've closed the fmt block
      if (braceDepth === 0 && i > fmtBlockStart) {
        // The closing brace is on this line
        lineIdx = i + 1;
        break;
      }
    }
  }

  // Extract the fmt block content
  let fmtBlockContent = '';
  if (fmtBlockStart !== -1) {
    // Find the closing brace
    let depth = 0;
    let started = false;
    let endLine = lines.length;

    for (let i = fmtBlockStart; i < lines.length; i++) {
      const line = lines[i];
      for (const char of line) {
        if (char === '{') {
          if (!started) started = true;
          depth++;
        } else if (char === '}') {
          depth--;
          if (started && depth === 0) {
            endLine = i;
            break;
          }
        }
      }
      if (depth === 0 && started) break;
    }

    fmtBlockContent = lines.slice(fmtBlockStart, endLine + 1).join('\n');
    lineIdx = endLine + 1;
  }

  // 3. Parse projectRootFile
  let projectRootFile = '';
  const projectRootMatch = fmtBlockContent.match(/projectRootFile\s*=\s*"([^"]+)"/);
  if (projectRootMatch) {
    projectRootFile = projectRootMatch[1];
  }

  // 4. Parse programs attrset
  const programs = parsePrograms(fmtBlockContent);

  // 5. Extract the programs comment (comment above "programs = {" line, if any)
  let programsComment: string | undefined;
  const programsLineIdx = fmtBlockContent.indexOf('programs = {');
  if (programsLineIdx !== -1) {
    // Look at the content before "programs = {" to find a preceding comment line
    const beforePrograms = fmtBlockContent.slice(0, programsLineIdx);
    const lines = beforePrograms.split('\n');
    // Check the last non-empty line before "programs = {"
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmedLine = lines[i].trim();
      if (trimmedLine === '') continue;
      if (trimmedLine.startsWith('#')) {
        programsComment = trimmedLine;
      }
      break;
    }
  }

  // 6. Extract the tail (everything after `in` — the expression part)
  let tail = '';
  const inIdx = content.indexOf('\nin');
  if (inIdx !== -1) {
    // Skip past "\nin" to get just the expression
    tail = content.slice(inIdx + 3).trim();
  }

  return { functionArgs, projectRootFile, programs, tail, programsComment };
}

function parsePrograms(blockContent: string): Map<string, ProgramConfig> {
  const programs = new Map<string, ProgramConfig>();

  // Find the programs = { ... } block
  const programsMatch = blockContent.match(/programs\s*=\s*\{/);
  if (!programsMatch) return programs;

  const startIdx = programsMatch.index! + programsMatch[0].length;
  let depth = 1;
  let i = startIdx;

  while (i < blockContent.length && depth > 0) {
    if (blockContent[i] === '{') depth++;
    else if (blockContent[i] === '}') depth--;
    i++;
  }

  const programsBlock = blockContent.slice(startIdx, i - 1);

  // Parse each program entry
  // Format: program-name.enable = true; OR program-name = { enable = true; ... };
  const lines = programsBlock.split('\n');
  let currentProgram: string | null = null;
  let currentConfig: ProgramConfig | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and closing brace
    if (!trimmed || trimmed === '}') {
      if (currentProgram && currentConfig) {
        programs.set(currentProgram, currentConfig);
        currentProgram = null;
        currentConfig = null;
      }
      continue;
    }

    // Single-line: program-name.enable = true;
    const singleLineMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\.enable\s*=\s*(true|false)\s*;?\s*$/);
    if (singleLineMatch) {
      if (currentProgram && currentConfig) {
        programs.set(currentProgram, currentConfig);
      }
      programs.set(singleLineMatch[1], { enable: singleLineMatch[2] === 'true' });
      currentProgram = null;
      currentConfig = null;
      continue;
    }

    // Multi-line start: program-name = {
    const multiStartMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*\{\s*$/);
    if (multiStartMatch) {
      if (currentProgram && currentConfig) {
        programs.set(currentProgram, currentConfig);
      }
      currentProgram = multiStartMatch[1];
      currentConfig = { enable: false };
      continue;
    }

    // Inside multi-line: enable = true/false;
    if (currentConfig) {
      const enableMatch = trimmed.match(/^enable\s*=\s*(true|false)\s*;?\s*$/);
      if (enableMatch) {
        currentConfig.enable = enableMatch[1] === 'true';
        continue;
      }

      // extra_args = [ ... ];
      const extraArgsMatch = trimmed.match(/^extra_args\s*=\s*\[\s*(.*?)\s*\]\s*;?\s*$/);
      if (extraArgsMatch) {
        // Parse the array content - simple approach: extract quoted strings
        const arrayContent = extraArgsMatch[1];
        const args: string[] = [];
        // Match all double-quoted strings in the array
        const stringMatches = arrayContent.matchAll(/"([^"]*)"/g);
        for (const match of stringMatches) {
          args.push(match[1]);
        }
        currentConfig.extra_args = args;
        continue;
      }

      // Other boolean fields
      const boolMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(true|false)\s*;?\s*$/);
      if (boolMatch) {
        (currentConfig as Record<string, unknown>)[boolMatch[1]] = boolMatch[2] === 'true';
        continue;
      }

      // Closing brace of this program
      if (trimmed === '};') {
        if (currentProgram && currentConfig) {
          programs.set(currentProgram, currentConfig);
          currentProgram = null;
          currentConfig = null;
        }
        continue;
      }
    }
  }

  return programs;
}

// ─── Merge ───────────────────────────────────────────────────────────────────

export function mergeFmt(
  sortedFiles: { content: string; layer: number; template: string }[],
): string {
  const parsed = sortedFiles.map((f) => parseFmt(f.content));

  // Function args: normalize by sorting alphabetically (handles different orderings)
  // Then validate all layers have the same normalized args (exact match required)
  const normalizedArgs = normalizeFunctionArgs(parsed[0].functionArgs);
  for (let i = 1; i < parsed.length; i++) {
    const otherArgs = normalizeFunctionArgs(parsed[i].functionArgs);
    if (otherArgs !== normalizedArgs) {
      throw new Error(
        `fmt.nix: function args mismatch — expected ${normalizedArgs}, got ${otherArgs} in layer ${i}`,
      );
    }
  }

  // projectRootFile: LWW (highest layer wins)
  const projectRootFile = parsed[parsed.length - 1].projectRootFile;

  // Validate no unknown top-level keys in any layer
  for (let i = 0; i < parsed.length; i++) {
    const content = sortedFiles[i].content;
    // Check for unknown keys in the fmt block (only projectRootFile and programs are allowed)
    // Find the fmt = { block
    const fmtMatch = content.match(/fmt\s*=\s*\{/);
    if (!fmtMatch) continue;

    const fmtStart = fmtMatch.index! + fmtMatch[0].length;

    // Find the matching closing brace for the fmt = { block
    let depth = 1;
    let j = fmtStart;
    while (j < content.length && depth > 0) {
      if (content[j] === '{') depth++;
      else if (content[j] === '}') depth--;
      j++;
    }

    if (depth === 0) {
      const fmtBlock = content.slice(fmtMatch.index!, j);
      // Find all top-level keys in the fmt block (before programs = {)
      // Skip the first line which is "fmt = {"
      const beforePrograms = fmtBlock.split(/programs\s*=\s*\{/)[0];
      const linesBeforePrograms = beforePrograms.split('\n');
      // Skip first line (fmt = {) and find keys
      const unknownKeys = [...linesBeforePrograms.slice(1).join('\n').matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=/gm)];
      for (const match of unknownKeys) {
        const key = match[1];
        if (key !== 'projectRootFile') {
          throw new Error(
            `fmt.nix: unknown top-level key "${key}" in layer ${i} (template: ${sortedFiles[i].template})`,
          );
        }
      }
    }
  }

  // Merge programs: deep merge by program name
  const mergedPrograms = new Map<string, ProgramConfig>();

  for (const p of parsed) {
    for (const [name, config] of p.programs) {
      if (!mergedPrograms.has(name)) {
        mergedPrograms.set(name, { enable: false });
      }
      const existing = mergedPrograms.get(name)!;

      // enable: true wins
      if (config.enable) {
        existing.enable = true;
      }

      // extra_args: LWW (highest layer wins)
      if (config.extra_args !== undefined) {
        existing.extra_args = config.extra_args;
      }

      // Other boolean fields: true wins
      for (const [key, value] of Object.entries(config)) {
        if (key !== 'enable' && key !== 'extra_args' && typeof value === 'boolean' && value) {
          (existing as Record<string, unknown>)[key] = value;
        }
      }
    }
  }

  return prettyPrint(
    normalizedArgs,
    projectRootFile,
    mergedPrograms,
    parsed[parsed.length - 1].tail,
    parsed[parsed.length - 1].programsComment,
  );
}

// ─── Pretty Print ────────────────────────────────────────────────────────────

function prettyPrint(
  functionArgs: string,
  projectRootFile: string,
  programs: Map<string, ProgramConfig>,
  tail: string,
  programsComment?: string,
): string {
  const lines: string[] = [];

  // Function args
  lines.push(`${functionArgs}:`);
  lines.push('let');
  lines.push('  fmt = {');

  // projectRootFile
  lines.push(`    projectRootFile = "${projectRootFile}";`);
  lines.push('');

  // Programs header comment (preserve from highest layer if present)
  if (programsComment) {
    lines.push(`    ${programsComment}`);
  }
  lines.push('    programs = {');

  // Sort programs alphabetically
  const sortedPrograms = [...programs.keys()].sort();

  for (let i = 0; i < sortedPrograms.length; i++) {
    const name = sortedPrograms[i];
    const config = programs.get(name)!;

    // Determine if this is a single-line or multi-line program
    const isSingleLine = Object.keys(config).length === 1 && config.enable === true;
    const otherKeys = Object.entries(config).filter(([k]) => k !== 'enable');

    if (isSingleLine) {
      lines.push(`      ${name}.enable = true;`);
    } else {
      lines.push(`      ${name} = {`);
      lines.push(`        enable = ${config.enable};`);
      for (const [key, value] of otherKeys) {
        if (key === 'extra_args' && Array.isArray(value)) {
          const quotedArgs = value.map((v) => `"${v}"`).join(' ');
          lines.push(`        extra_args = [ ${quotedArgs} ];`);
        } else if (typeof value === 'boolean') {
          lines.push(`        ${key} = ${value};`);
        }
      }
      lines.push('      };');
    }
  }

  lines.push('    };');
  lines.push('');
  lines.push('  };');
  lines.push('in');
  lines.push(tail);
  lines.push('');

  return lines.join('\n');
}
