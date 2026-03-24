// merge-precommit.ts — Parser, merger, and pretty-printer for pre-commit.nix files

interface HookConfig {
  enable: boolean;
  name?: string;
  description?: string;
  entry?: string;
  files?: string;
  language?: string;
  package?: string;
  pass_filenames?: boolean;
  excludes?: string[];
  stages?: string[];
  // Passthrough fields (preserved as-is from highest layer)
  [key: string]: boolean | string | string[] | undefined;
}

interface ParsedPrecommit {
  functionArgs: string;
  src: string;
  hooks: Map<string, HookConfig>;
  hasRec: Map<string, boolean>; // tracks which hooks use `rec`
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

function extractQuotedStrings(arrContent: string): string[] {
  const strings: string[] = [];
  const matches = arrContent.matchAll(/"([^"]*)"/g);
  for (const match of matches) {
    strings.push(match[1]);
  }
  return strings;
}

// Fields that take Nix identifiers (should NOT be quoted)
const NIX_IDENTIFIER_FIELDS = ['language', 'package'];

// Determines if a string value should be quoted in Nix output
function needsQuotes(key: string, value: string): boolean {
  // Nix identifier fields should not be quoted
  if (NIX_IDENTIFIER_FIELDS.includes(key)) {
    return false;
  }
  // All other string fields should be quoted
  return true;
}

// ─── Parse ───────────────────────────────────────────────────────────────────

function parsePrecommit(content: string): ParsedPrecommit {
  const lines = content.split('\n');

  // 1. Extract function args line — match ^{...}:
  let functionArgs = '';
  let lineIdx = 0;

  const argsMatch = lines[0]?.match(/^\s*(\{[^}]+\})\s*:\s*$/);
  if (argsMatch) {
    functionArgs = argsMatch[1];
    lineIdx = 1;
  }

  // 2. Detect pre-commit-lib.run { wrapper and find hooks block
  let inRunBlock = false;
  let runBlockStart = -1;
  let runBlockEnd = -1;
  let braceDepth = 0;

  for (let i = lineIdx; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!inRunBlock) {
      if (trimmed === 'pre-commit-lib.run {') {
        inRunBlock = true;
        runBlockStart = i;
        braceDepth = 1;
        continue;
      }
    } else {
      for (const char of line) {
        if (char === '{') braceDepth++;
        else if (char === '}') braceDepth--;
      }
      if (braceDepth === 0) {
        runBlockEnd = i;
        break;
      }
    }
  }

  // Extract the run block content
  let runBlockContent = '';
  if (runBlockStart !== -1 && runBlockEnd !== -1) {
    runBlockContent = lines.slice(runBlockStart, runBlockEnd + 1).join('\n');
  }

  // 3. Extract src value
  let src = './.';
  const srcMatch = runBlockContent.match(/src\s*=\s*(\.\/[^;]+);/);
  if (srcMatch) {
    src = srcMatch[1];
  }

  // 4. Extract hooks attrset
  const hooks = parseHooks(runBlockContent);
  const hasRec = detectRecHooks(runBlockContent);

  return { functionArgs, src, hooks, hasRec };
}

function detectRecHooks(blockContent: string): Map<string, boolean> {
  const hasRec = new Map<string, boolean>();

  // Match "hook-name = rec {" pattern - hook names can have hyphens
  const recPattern = /^(\s*)([\w-]+)\s*=\s*rec\s*\{/gm;
  let match;
  while ((match = recPattern.exec(blockContent)) !== null) {
    hasRec.set(match[2], true);
  }

  return hasRec;
}

function parseHooks(blockContent: string): Map<string, HookConfig> {
  const hooks = new Map<string, HookConfig>();

  // Find hooks = { ... } block
  const hooksMatch = blockContent.match(/hooks\s*=\s*\{/);
  if (!hooksMatch) return hooks;

  const startIdx = blockContent.indexOf('{', hooksMatch.index!);
  let depth = 0;
  let i = startIdx;
  let started = false;

  while (i < blockContent.length) {
    const char = blockContent[i];
    if (char === '{') {
      if (!started) started = true;
      depth++;
    } else if (char === '}') {
      depth--;
      if (started && depth === 0) {
        break;
      }
    }
    i++;
  }

  const hooksBlock = blockContent.slice(startIdx + 1, i);

  // Parse each hook entry
  const lines = hooksBlock.split('\n');
  let currentHook: string | null = null;
  let currentConfig: HookConfig | null = null;
  let inMultiLine = false;
  let inArrayField: string | null = null;
  let arrayContent: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Check if we're in an array field (multi-line array)
    if (inArrayField) {
      // Look for closing bracket
      if (trimmed === '];') {
        if (inArrayField === 'excludes') {
          currentConfig!.excludes = [...arrayContent];
        } else if (inArrayField === 'stages') {
          currentConfig!.stages = [...arrayContent];
        }
        inArrayField = null;
        arrayContent = [];
        continue;
      }
      // Collect array items (quoted strings)
      const itemMatch = trimmed.match(/^\s*"([^"]+)"\s*$/);
      if (itemMatch) {
        arrayContent.push(itemMatch[1]);
      }
      continue;
    }

    // Single-line hook: hookname.enable = true/false;
    const singleLineMatch = trimmed.match(/^([\w-]+)\.enable\s*=\s*(true|false)\s*;?\s*$/);
    if (singleLineMatch) {
      // Save previous hook
      if (currentHook && currentConfig) {
        hooks.set(currentHook, currentConfig);
      }
      hooks.set(singleLineMatch[1], { enable: singleLineMatch[2] === 'true' });
      currentHook = null;
      currentConfig = null;
      inMultiLine = false;
      continue;
    }

    // Multi-line hook start: hookname = {
    const multiStartMatch = trimmed.match(/^([\w-]+)\s*=\s*\{\s*$/);
    if (multiStartMatch) {
      // Save previous hook
      if (currentHook && currentConfig) {
        hooks.set(currentHook, currentConfig);
      }
      currentHook = multiStartMatch[1];
      currentConfig = { enable: false };
      inMultiLine = true;
      continue;
    }

    // Multi-line hook start with rec: hookname = rec {
    const multiRecStartMatch = trimmed.match(/^([\w-]+)\s*=\s*rec\s*\{\s*$/);
    if (multiRecStartMatch) {
      // Save previous hook
      if (currentHook && currentConfig) {
        hooks.set(currentHook, currentConfig);
      }
      currentHook = multiRecStartMatch[1];
      currentConfig = { enable: false };
      inMultiLine = true;
      continue;
    }

    // Inside multi-line hook
    if (inMultiLine && currentConfig) {
      // Closing brace
      if (trimmed === '};') {
        if (currentHook && currentConfig) {
          hooks.set(currentHook, currentConfig);
          currentHook = null;
          currentConfig = null;
          inMultiLine = false;
        }
        continue;
      }

      // enable field
      const enableMatch = trimmed.match(/^enable\s*=\s*(true|false)\s*;?\s*$/);
      if (enableMatch) {
        currentConfig.enable = enableMatch[1] === 'true';
        continue;
      }

      // name field (string)
      const nameMatch = trimmed.match(/^name\s*=\s*"([^"]+)"\s*;?\s*$/);
      if (nameMatch) {
        currentConfig.name = nameMatch[1];
        continue;
      }

      // description field (string)
      const descMatch = trimmed.match(/^description\s*=\s*"([^"]+)"\s*;?\s*$/);
      if (descMatch) {
        currentConfig.description = descMatch[1];
        continue;
      }

      // entry field (string)
      const entryMatch = trimmed.match(/^entry\s*=\s*"([^"]+)"\s*;?\s*$/);
      if (entryMatch) {
        currentConfig.entry = entryMatch[1];
        continue;
      }

      // files field (string)
      const filesMatch = trimmed.match(/^files\s*=\s*"([^"]+)"\s*;?\s*$/);
      if (filesMatch) {
        currentConfig.files = filesMatch[1];
        continue;
      }

      // language field (string)
      const langMatch = trimmed.match(/^language\s*=\s*"([^"]+)"\s*;?\s*$/);
      if (langMatch) {
        currentConfig.language = langMatch[1];
        continue;
      }

      // package field (string, can be just an identifier like formatter or packages.infralint)
      const packageMatch = trimmed.match(/^package\s*=\s*([^\s;]+)\s*;?\s*$/);
      if (packageMatch) {
        currentConfig.package = packageMatch[1];
        continue;
      }

      // pass_filenames field (boolean)
      const passMatch = trimmed.match(/^pass_filenames\s*=\s*(true|false)\s*;?\s*$/);
      if (passMatch) {
        currentConfig.pass_filenames = passMatch[1] === 'true';
        continue;
      }

      // Multi-line excludes field (array) - starts with excludes = [
      if (trimmed.startsWith('excludes = [')) {
        inArrayField = 'excludes';
        arrayContent = [];
        // Check if there's anything on the same line after [
        const afterBracket = trimmed.slice(trimmed.indexOf('[') + 1).trim();
        if (afterBracket === ']') {
          // Empty array
          currentConfig.excludes = [];
          inArrayField = null;
        }
        continue;
      }

      // Multi-line stages field (array)
      if (trimmed.startsWith('stages = [')) {
        inArrayField = 'stages';
        arrayContent = [];
        const afterBracket = trimmed.slice(trimmed.indexOf('[') + 1).trim();
        if (afterBracket === ']') {
          currentConfig.stages = [];
          inArrayField = null;
        }
        continue;
      }

      // passthrough fields (any other key = value;)
      const passthroughMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*([^;]+)\s*;?\s*$/);
      if (passthroughMatch) {
        const key = passthroughMatch[1];
        const value = passthroughMatch[2].trim();
        // Only handle simple values (not complex expressions)
        if (value === 'true' || value === 'false') {
          (currentConfig as Record<string, unknown>)[key] = value === 'true';
        } else if (value.startsWith('"') && value.endsWith('"')) {
          (currentConfig as Record<string, unknown>)[key] = value.slice(1, -1);
        } else {
          (currentConfig as Record<string, unknown>)[key] = value;
        }
        continue;
      }
    }
  }

  // Save last hook if any
  if (currentHook && currentConfig) {
    hooks.set(currentHook, currentConfig);
  }

  return hooks;
}

// ─── Merge ───────────────────────────────────────────────────────────────────

export function mergePrecommit(
  sortedFiles: { content: string; layer: number; template: string }[],
): string {
  const parsed = sortedFiles.map((f) => parsePrecommit(f.content));

  // Function args: exact string match — fail if different
  const firstArgs = parsed[0].functionArgs;
  for (const p of parsed) {
    if (p.functionArgs !== firstArgs) {
      throw new Error(
        `pre-commit.nix function args mismatch: "${p.functionArgs}" vs "${firstArgs}"`,
      );
    }
  }

  // src: highest layer wins
  const src = parsed[parsed.length - 1].src;

  // Merge hooks: deep merge per hook key
  const mergedHooks = new Map<string, HookConfig>();
  const mergedRec = new Map<string, boolean>();

  for (const p of parsed) {
    for (const [name, config] of p.hooks) {
      if (!mergedHooks.has(name)) {
        mergedHooks.set(name, { enable: false });
      }
      const existing = mergedHooks.get(name)!;

      // enable: true wins over false
      if (config.enable) {
        existing.enable = true;
      }

      // String fields: highest layer wins (LWW)
      if (config.name !== undefined) existing.name = config.name;
      if (config.description !== undefined) existing.description = config.description;
      if (config.entry !== undefined) existing.entry = config.entry;
      if (config.files !== undefined) existing.files = config.files;
      if (config.language !== undefined) existing.language = config.language;
      if (config.package !== undefined) existing.package = config.package;

      // Boolean fields: highest layer wins
      if (config.pass_filenames !== undefined) existing.pass_filenames = config.pass_filenames;

      // Array fields: concat + dedupe
      if (config.excludes !== undefined) {
        if (!existing.excludes) existing.excludes = [];
        for (const ex of config.excludes) {
          if (!existing.excludes!.includes(ex)) existing.excludes!.push(ex);
        }
      }
      if (config.stages !== undefined) {
        if (!existing.stages) existing.stages = [];
        for (const st of config.stages) {
          if (!existing.stages!.includes(st)) existing.stages!.push(st);
        }
      }

      // Passthrough fields: highest layer wins
      for (const [key, value] of Object.entries(config)) {
        if (
          !['enable', 'name', 'description', 'entry', 'files', 'language', 'package', 'pass_filenames', 'excludes', 'stages'].includes(key)
        ) {
          (existing as Record<string, unknown>)[key] = value;
        }
      }
    }

    // Merge rec flags
    for (const [name, hasRec] of p.hasRec) {
      if (hasRec) {
        mergedRec.set(name, true);
      }
    }
  }

  // Sort excludes and stages if present
  for (const config of mergedHooks.values()) {
    if (config.excludes) config.excludes.sort();
    if (config.stages) config.stages.sort();
  }

  return prettyPrint(firstArgs, src, mergedHooks, mergedRec);
}

// ─── Pretty Print ────────────────────────────────────────────────────────────

function prettyPrint(
  functionArgs: string,
  src: string,
  hooks: Map<string, HookConfig>,
  hasRec: Map<string, boolean>,
): string {
  const lines: string[] = [];

  // Function args (sort alphabetically)
  const sortedArgs = sortFunctionArgs(functionArgs);
  lines.push(`${sortedArgs}:`);

  // pre-commit-lib.run { ... }
  lines.push('pre-commit-lib.run {');
  lines.push(`  src = ${src};`);
  lines.push('');
  lines.push('  hooks = {');

  // Sort hooks alphabetically
  const sortedHookNames = [...hooks.keys()].sort();

  for (let i = 0; i < sortedHookNames.length; i++) {
    const name = sortedHookNames[i];
    const config = hooks.get(name)!;
    const isRec = hasRec.get(name) ?? false;

    // Blank line between hooks (not before first)
    if (i > 0) {
      lines.push('');
    }

    // Determine if single-line or multi-line
    const isSingleLine = Object.keys(config).length === 1 && 'enable' in config;

    if (isSingleLine) {
      lines.push(`    ${name}.enable = ${config.enable};`);
    } else {
      // Multi-line hook
      if (isRec) {
        lines.push(`    ${name} = rec {`);
      } else {
        lines.push(`    ${name} = {`);
      }
      lines.push(`      enable = ${config.enable};`);

      // Fields in order: description, entry, excludes, files, language, name, package, pass_filenames, stages
      const fieldOrder = ['description', 'entry', 'excludes', 'files', 'language', 'name', 'package', 'pass_filenames', 'stages'];
      const emittedKeys = new Set<string>(['enable']);

      for (const key of fieldOrder) {
        emittedKeys.add(key);
        if (key === 'excludes' && config.excludes) {
          lines.push(`      excludes = [`);
          for (const ex of config.excludes) {
            lines.push(`        "${ex}"`);
          }
          lines.push('      ];');
        } else if (key === 'stages' && config.stages) {
          lines.push(`      stages = [`);
          for (const st of config.stages) {
            lines.push(`        "${st}"`);
          }
          lines.push('      ];');
        } else if (key in config && config[key as keyof HookConfig] !== undefined) {
          const value = config[key as keyof HookConfig];
          if (typeof value === 'string') {
            // Use needsQuotes to determine if quotes are needed
            if (needsQuotes(key, value)) {
              lines.push(`      ${key} = "${value}";`);
            } else {
              lines.push(`      ${key} = ${value};`);
            }
          } else if (typeof value === 'boolean') {
            lines.push(`      ${key} = ${value};`);
          }
        }
      }

      // Emit passthrough fields (non-standard hook options from highest layer)
      for (const key of Object.keys(config).sort()) {
        if (emittedKeys.has(key)) continue;
        const value = config[key];
        if (value === undefined) continue;
        if (typeof value === 'string') {
          if (needsQuotes(key, value)) {
            lines.push(`      ${key} = "${value}";`);
          } else {
            lines.push(`      ${key} = ${value};`);
          }
        } else if (typeof value === 'boolean') {
          lines.push(`      ${key} = ${value};`);
        }
      }

      lines.push('    };');
    }
  }

  lines.push('  };');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

function sortFunctionArgs(argsStr: string): string {
  // Parse function args like "{ pkgs, treefmt-nix, ... }" and sort them alphabetically
  const match = argsStr.match(/^\{([^}]+)\}$/);
  if (!match) return argsStr;

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