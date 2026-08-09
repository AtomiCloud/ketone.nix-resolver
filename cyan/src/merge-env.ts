// merge-env.ts — Parser, merger, and pretty-printer for env.nix files

import { findFunctionHeader, maskNixTrivia } from './loss-guard.ts';

interface ParsedEnv {
  functionArgs: string;
  /** Sorted argument source texts — the order-independent identity of the head. */
  argSignature: string;
  withPackages: boolean;
  categories: Map<string, string[]>;
}

// ─── Parse ───────────────────────────────────────────────────────────────────

function parseEnv(content: string): ParsedEnv {
  // The head used to be matched with `lines[0].match(/^\s*(\{[^}]+\})\s*:\s*$/)` — it had
  // to fit on line 1. `nix/env.nix` has a short head today, so this file never tripped in
  // the field, but the defect is the same one that collapsed `nix/packages.nix` to `{ }:`
  // and `nix/shells.nix` to a headless skeleton: the moment treefmt breaks the head across
  // lines, `functionArgs` empties, the `with packages;` probe looks at an argument instead
  // of the prelude, and both are dropped without a word. Parse it structurally.
  const code = maskNixTrivia(content);
  const header = findFunctionHeader(content);
  if (!header) {
    throw new Error(
      'Cannot merge nix/env.nix: no function argument set was found. The file must begin ' +
        'with a `{ ... }:` head (single-line or multi-line); refusing rather than emitting ' +
        'a headless skeleton.',
    );
  }
  // Rendered in source order: this is the head that gets printed back out, and reordering
  // it would rewrite every existing file for no gain. Equality across layers is checked
  // separately, on a sorted normalisation, so `{ pkgs, packages }` and `{ packages, pkgs }`
  // are still recognised as the same head.
  // Emitted from each argument's own source text, so a default (`pkgs ? import <nixpkgs> {}`)
  // survives the round trip. Rebuilding from names alone would drop it silently, and no
  // *name* would be missing for the loss guard to catch.
  const renderedArgs = header.args.map((name) => (header.argSources.get(name) ?? name).replace(/\s+/g, ' '));
  const functionArgs = `{ ${renderedArgs.join(', ')}${header.hasEllipsis ? ', ...' : ''} }`;
  // Compared as a sorted list of whole arguments, never by re-splitting the rendered
  // string on commas — a default may itself contain a comma.
  const argSignature = JSON.stringify([...renderedArgs].sort().concat(header.hasEllipsis ? ['...'] : []));

  // 2. Detect the optional `with packages;` prelude between the head and the attrset
  let cursor = header.colonIndex + 1;
  while (cursor < code.length && /\s/.test(code[cursor])) cursor++;
  const withMatch = code.slice(cursor).match(/^with\s+packages\s*;/);
  let withPackages = false;
  if (withMatch) {
    withPackages = true;
    cursor += withMatch[0].length;
  }

  if (code.slice(cursor).trimStart()[0] !== '{') {
    throw new Error(
      'Cannot merge nix/env.nix: the top-level category attribute set was not found after ' +
        'the function head. Refusing rather than emitting an empty skeleton.',
    );
  }

  // 3. Parse the top-level attrset: each key maps to a list
  const categories = new Map<string, string[]>();
  let currentCategory: string | null = null;
  let inList = false;
  const lines = content.split('\n');
  const lineIdx = content.slice(0, cursor).split('\n').length - 1;

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
      // A single-line list — `dev = [ git go-task ];` — closes on this same line. The
      // scanner used to record the category, drop every item on the line, and leave
      // `inList` true, so the *next* category's items were then appended to this one.
      // Both halves of that are silent corruption the loss guard cannot see: package
      // names inside a list are values, not bindings.
      const rest = trimmed.slice(catMatch[0].length);
      const closing = rest.indexOf(']');
      if (closing !== -1) {
        for (const item of rest.slice(0, closing).trim().split(/\s+/).filter(Boolean)) {
          categories.get(currentCategory)!.push(item);
        }
        inList = false;
        currentCategory = null;
      }
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

  if (categories.size === 0) {
    throw new Error(
      'Cannot merge nix/env.nix: no `<category> = [ ... ];` entries were found. Refusing ' +
        'rather than emitting an empty skeleton that silently drops every package list.',
    );
  }

  return { functionArgs, argSignature, withPackages, categories };
}

// ─── Merge ───────────────────────────────────────────────────────────────────

export function mergeEnv(
  sortedFiles: { content: string; layer: number; template: string }[],
): string {
  if (sortedFiles.length === 0) {
    // Zero inputs is the one case the loss guard cannot catch — nothing was supplied, so
    // nothing is missing — and without this the merger dies on `parsed[0]` with an
    // implementation TypeError instead of a refusal the caller can act on.
    throw new Error('Cannot merge nix/env.nix: no files were provided; at least one is required.');
  }
  const parsed = sortedFiles.map((f) => parseEnv(f.content));

  // Function args: same set across all inputs — fail if different. Compared on a sorted
  // normalisation so a pure reordering (or a reflow across lines) is not a conflict.
  const firstArgs = parsed[0].functionArgs;
  const firstNormalized = parsed[0].argSignature;
  for (const p of parsed) {
    if (p.argSignature !== firstNormalized) {
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
