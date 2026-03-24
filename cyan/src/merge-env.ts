// merge-env.ts — Parser, merger, and pretty-printer for env.nix files

interface ParsedEnv {
  functionArgs: string;
  withPackages: boolean;
  categories: Map<string, string[]>;
}

// ─── Parse ───────────────────────────────────────────────────────────────────

function parseEnv(content: string): ParsedEnv {
  const lines = content.split('\n');

  // 1. Extract function args line — match ^{...}:
  let functionArgs = '';
  let lineIdx = 0;

  const argsMatch = lines[0]?.match(/^\s*(\{[^}]+\})\s*:\s*$/);
  if (argsMatch) {
    functionArgs = argsMatch[1];
    lineIdx = 1;
  }

  // 2. Detect optional `with packages;` line
  let withPackages = false;
  if (lineIdx < lines.length) {
    const withMatch = lines[lineIdx].match(/^\s*with\s+packages\s*;\s*$/);
    if (withMatch) {
      withPackages = true;
      lineIdx++;
    }
  }

  // 3. Parse the top-level attrset: each key maps to a list
  const categories = new Map<string, string[]>();
  let currentCategory: string | null = null;
  let inList = false;

  for (let i = lineIdx; i < lines.length; i++) {
    const line = lines[i];
    let trimmed = line.trim();

    // Skip opening brace
    if (trimmed === '{') continue;
    // Stop at closing brace
    if (trimmed === '}') break;

    // Category assignment: key = [
    const catMatch = trimmed.match(/^([\w-]+)\s*=\s*\[/);
    if (catMatch) {
      currentCategory = catMatch[1];
      categories.set(currentCategory, []);
      inList = true;
      continue;
    }

    // Closing bracket (end of list)
    if (trimmed === '];') {
      inList = false;
      currentCategory = null;
      continue;
    }

    // Inside a list: extract package names (skip empty lines and comments)
    if (inList && currentCategory) {
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Strip inline comments (# to end of line), but be careful not to
      // strip '#' inside quoted strings (simple heuristic: only strip after whitespace)
      const commentIdx = trimmed.indexOf('#');
      if (commentIdx > 0 && trimmed[commentIdx - 1] === ' ') {
        trimmed = trimmed.slice(0, commentIdx).trim();
      }
      if (trimmed) categories.get(currentCategory)!.push(trimmed);
    }
  }

  return { functionArgs, withPackages, categories };
}

// ─── Merge ───────────────────────────────────────────────────────────────────

export function mergeEnv(
  sortedFiles: { content: string; layer: number; template: string }[],
): string {
  const parsed = sortedFiles.map((f) => parseEnv(f.content));

  // Function args: exact string match across all inputs — fail if different
  const firstArgs = parsed[0].functionArgs;
  for (const p of parsed) {
    if (p.functionArgs !== firstArgs) {
      throw new Error(
        `env.nix function args mismatch: "${p.functionArgs}" vs "${firstArgs}"`,
      );
    }
  }

  // `with packages;` must be consistent across all inputs
  const firstWith = parsed[0].withPackages;
  for (const p of parsed) {
    if (p.withPackages !== firstWith) {
      throw new Error(
        'env.nix "with packages;" presence mismatch across inputs',
      );
    }
  }

  // Merge categories: union all categories, deduplicate and sort packages
  const mergedCategories = new Map<string, Set<string>>();

  for (const p of parsed) {
    for (const [category, packages] of p.categories) {
      if (!mergedCategories.has(category)) {
        mergedCategories.set(category, new Set());
      }
      for (const pkg of packages) {
        mergedCategories.get(category)!.add(pkg);
      }
    }
  }

  return prettyPrint(firstArgs, firstWith, mergedCategories);
}

// ─── Pretty Print ────────────────────────────────────────────────────────────

function prettyPrint(
  functionArgs: string,
  withPackages: boolean,
  categories: Map<string, Set<string>>,
): string {
  const lines: string[] = [];

  // Function args
  lines.push(`${functionArgs}:`);
  if (withPackages) {
    lines.push('with packages;');
  }

  // Opening brace
  lines.push('{');

  // Sort categories alphabetically
  const sortedCategories = [...categories.keys()].sort();

  for (let i = 0; i < sortedCategories.length; i++) {
    const cat = sortedCategories[i];
    const packages = [...categories.get(cat)!].sort();

    // Blank line between categories (not before first)
    if (i > 0) {
      lines.push('');
    }

    lines.push(`  ${cat} = [`);
    for (const pkg of packages) {
      lines.push(`    ${pkg}`);
    }
    lines.push('  ];');
  }

  // Closing brace + trailing newline
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}
