// merge-precommit.ts — Parser, merger, and pretty-printer for pre-commit.nix files

import { findFunctionHeader, maskNixTrivia } from './loss-guard.ts';
import { collapseArgWhitespace, compareCodeUnits, orderedUnion, printFunctionHead } from './nix-print.ts';

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

/** One `let` binding: the exact statement text plus the comment block directly above it. */
interface LetBinding {
  comment: string[];
  text: string;
  /** Column the statement started at in its source file. */
  indent: number;
}

/** The part between the function head and `pre-commit-lib.run`: an optional `let ... in` and whatever follows it. */
interface ParsedPrelude {
  hasLet: boolean;
  /** Comment lines above `let`. */
  leadingComment: string[];
  /** Binding name → binding, in source order. */
  bindings: Map<string, LetBinding>;
  /** Comment lines after the last binding, before `in`. */
  trailingComment: string[];
  /** Everything after `in` (or the whole prelude when there is no `let`), e.g. `with x;`. */
  rest: string;
}

interface ParsedPrecommit {
  argNames: string[];
  argSources: Map<string, string>;
  hasEllipsis: boolean;
  prelude: ParsedPrelude;
  src: string;
  hooks: Map<string, HookConfig>;
  hasRec: Map<string, boolean>; // tracks which hooks use `rec`
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 0;
  let inString = false;

  for (let i = openIdx; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (char === '\\') {
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '#') {
      const newline = text.indexOf('\n', i);
      if (newline === -1) break;
      i = newline;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return i;
    }
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
const NIX_IDENTIFIER_FIELDS = ['package'];

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
  // The function header in diene's files is normally multi-line, so it is parsed
  // structurally rather than line by line.
  const header = findFunctionHeader(content);
  if (!header) {
    throw new Error('pre-commit.nix function header not found');
  }
  const bodyStart = header.colonIndex + 1;

  // The `let` prelude is parsed into named bindings so layers can be unioned: hook
  // configuration may refer to bindings declared there, so dropping one makes a
  // syntactically valid but unevaluable output even when the hook merge is correct.
  const body = content.slice(bodyStart);
  const runMatch = /\bpre-commit-lib\.run\s*\{/.exec(body);
  if (!runMatch || runMatch.index === undefined) {
    throw new Error('pre-commit.nix pre-commit-lib.run block not found');
  }
  const runBlockStart = bodyStart + runMatch.index;
  const runOpen = content.indexOf('{', runBlockStart);
  const runBlockEnd = findMatchingBrace(content, runOpen);
  if (runBlockEnd === -1) {
    throw new Error('pre-commit.nix pre-commit-lib.run block is not closed');
  }
  const prelude = parsePrelude(content.slice(bodyStart, runBlockStart));
  const runBlockContent = content.slice(runBlockStart, runBlockEnd + 1);

  // 3. Extract src value
  let src = './.';
  const srcMatch = runBlockContent.match(/\bsrc\s*=\s*([^;]+);/);
  if (srcMatch) {
    src = srcMatch[1].trim();
  }

  // 4. Extract hooks attrset
  const hooks = parseHooks(runBlockContent);
  const hasRec = detectRecHooks(runBlockContent);

  return {
    argNames: header.args,
    argSources: header.argSources,
    hasEllipsis: header.hasEllipsis,
    prelude,
    src,
    hooks,
    hasRec,
  };
}

const KEYWORD = /(?<![\w'.-])(let|in)(?![\w'-])/g;

function parsePrelude(raw: string): ParsedPrelude {
  const text = raw.trim();
  const empty = { hasLet: false, leadingComment: [], bindings: new Map<string, LetBinding>(), trailingComment: [], rest: text };
  if (text === '') return empty;

  const code = maskNixTrivia(text);
  const keywords = [...code.matchAll(KEYWORD)].map((m) => ({ word: m[1], index: m.index! }));
  if (keywords.length === 0 || keywords[0].word !== 'let' || code.slice(0, keywords[0].index).trim() !== '') return empty;
  const letIndex = keywords[0].index;

  let depth = 0;
  let inIndex = -1;
  for (const k of keywords) {
    depth += k.word === 'let' ? 1 : -1;
    if (depth === 0) {
      inIndex = k.index;
      break;
    }
  }
  if (inIndex === -1) throw new Error('pre-commit.nix let prelude has no matching `in`');

  const bodyStart = letIndex + 'let'.length;
  const bindings = new Map<string, LetBinding>();
  const nested = new Map(keywords.map((k) => [k.index, k.word]));
  let cursor = bodyStart;
  let bracket = 0;
  let letDepth = 0;
  let pendingPreludes = 0;
  let statementStart = bodyStart;
  for (let i = bodyStart; i < inIndex; i++) {
    const word = nested.get(i);
    if (word === 'let') letDepth++;
    else if (word === 'in') letDepth--;
    const ch = code[i];
    // A `with x;` / `assert x;` prelude inside a binding value owns the next top-level `;`.
    if (bracket === 0 && letDepth === 0 && !/[\w'.-]/.test(code[i - 1] ?? '') && /^(?:with|assert)(?![\w'-])/.test(code.slice(i, i + 7))) {
      pendingPreludes++;
      i += code.startsWith('with', i) ? 3 : 5;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') bracket++;
    else if (ch === '}' || ch === ']' || ch === ')') bracket--;
    else if (ch === ';' && bracket === 0 && letDepth === 0) {
      if (pendingPreludes > 0) {
        pendingPreludes--;
        continue;
      }
      addLetStatement(text, code, statementStart, i + 1, bindings);
      statementStart = i + 1;
      cursor = i + 1;
    }
  }
  const trailing = text.slice(cursor, inIndex);
  if (maskNixTrivia(trailing).trim() !== '') {
    throw new Error('pre-commit.nix let prelude has a binding that is not terminated by a `;`');
  }
  return {
    hasLet: true,
    leadingComment: commentLines(text.slice(0, letIndex)),
    bindings,
    trailingComment: commentLines(trailing),
    rest: text.slice(inIndex + 'in'.length).trim(),
  };
}

/** The comment text in `gap` (only whitespace and comments), whole and re-based to column 0. */
function commentLines(gap: string): string[] {
  const trimmed = gap.trim();
  if (trimmed === '') return [];
  const offset = gap.length - gap.trimStart().length;
  const lines = trimmed.split('\n');
  // A gap that opens with a same-line trailing comment has no column of its own; later lines
  // sit at the indent the author gave the comment block that follows.
  const startColumn = gap.slice(0, offset).includes('\n')
    ? offset - (gap.lastIndexOf('\n', offset - 1) + 1)
    : Math.min(Infinity, ...lines.slice(1).filter((l) => l.trim() !== '').map((l) => l.match(/^[ \t]*/)![0].length));
  return lines.map((line, index) => {
    if (index === 0) return line.trimEnd();
    if (line.trim() === '') return '';
    return line.slice(Math.min(startColumn, line.match(/^[ \t]*/)![0].length)).trimEnd();
  });
}

function addLetStatement(text: string, code: string, start: number, end: number, out: Map<string, LetBinding>): void {
  // Split the gap above the statement into its comment block and the statement itself.
  const maskedStatement = code.slice(start, end);
  const lead = maskedStatement.length - maskedStatement.trimStart().length;
  const gap = text.slice(start, start + lead);
  const bodyFrom = start + lead;
  const statement = text.slice(bodyFrom, end);
  const maskedBody = code.slice(bodyFrom, end);
  const comment = commentLines(gap);
  const indent = gap.length - (gap.lastIndexOf('\n') + 1);

  const inherit = maskedBody.match(/^inherit\b([\s\S]*);$/);
  if (inherit) {
    let rest = inherit[1].trim();
    let source = '';
    if (rest.startsWith('(')) {
      let depth = 0;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '(') depth++;
        if (rest[i] === ')' && --depth === 0) {
          source = rest.slice(0, i + 1) + ' ';
          rest = rest.slice(i + 1);
          break;
        }
      }
    }
    // The statement text is re-read from the source so a source expression keeps its bytes.
    const names = rest.match(/[a-zA-Z_][\w'-]*/g) ?? [];
    const sourceText = source ? statement.slice(statement.indexOf('('), statement.indexOf('(') + source.trimEnd().length) + ' ' : '';
    names.forEach((name, index) => {
      out.set(name, { comment: index === 0 ? comment : [], text: `inherit ${sourceText}${name};`, indent });
    });
    return;
  }

  const assignment = maskedBody.match(/^([a-zA-Z_][\w'-]*(?:\s*\.\s*[a-zA-Z_][\w'-]*)*)\s*=/);
  if (!assignment) {
    throw new Error(`pre-commit.nix let prelude has a binding this merger does not model: "${statement.split('\n')[0].trim()}"`);
  }
  out.set(assignment[1].replace(/\s+/g, ''), { comment, text: statement, indent });
}

function printLetBinding(binding: LetBinding): string[] {
  const lines = binding.comment.map((c) => (c ? `  ${c}` : ''));
  // Continuation lines move by the same amount the statement's first line did, so a
  // binding written at another indent still lands at the two-space let indent.
  const shift = 2 - binding.indent;
  binding.text.split('\n').forEach((line, index) => {
    if (index === 0) lines.push(`  ${line}`);
    else if (line.trim() === '' || shift === 0) lines.push(line.trim() === '' ? '' : line);
    else if (shift > 0) lines.push(' '.repeat(shift) + line);
    else lines.push(line.slice(Math.min(-shift, line.match(/^\s*/)![0].length)));
  });
  return lines;
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

/** Net open `[`, `(` and `{` in `text`, ignoring brackets inside strings and comments. */
function bracketDepth(text: string): number {
  const code = maskNixTrivia(text);
  let depth = 0;
  for (const char of code) {
    if (char === '[' || char === '(' || char === '{') depth++;
    else if (char === ']' || char === ')' || char === '}') depth--;
  }
  return depth;
}

/** True once `text` has closed every bracket and ends at a `;` — the end of a binding. */
function statementComplete(text: string): boolean {
  return bracketDepth(text) <= 0 && maskNixTrivia(text).trimEnd().endsWith(';');
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

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
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

      // Excludes field (array) - handle both inline and multi-line
      const excludesInlineMatch = trimmed.match(/^excludes\s*=\s*\[(.*)\]\s*;?\s*$/);
      if (excludesInlineMatch) {
        const arrayContent = excludesInlineMatch[1].trim();
        if (arrayContent) {
          currentConfig.excludes = extractQuotedStrings(arrayContent);
        } else {
          currentConfig.excludes = [];
        }
        continue;
      }
      if (trimmed.startsWith('excludes = [')) {
        inArrayField = 'excludes';
        arrayContent = [];
        continue;
      }

      // Stages field (array) - handle both inline and multi-line
      const stagesInlineMatch = trimmed.match(/^stages\s*=\s*\[(.*)\]\s*;?\s*$/);
      if (stagesInlineMatch) {
        const arrayContent = stagesInlineMatch[1].trim();
        if (arrayContent) {
          currentConfig.stages = extractQuotedStrings(arrayContent);
        } else {
          currentConfig.stages = [];
        }
        continue;
      }
      if (trimmed.startsWith('stages = [')) {
        inArrayField = 'stages';
        arrayContent = [];
        continue;
      }

      // A value that spans lines (`entry = validators [ ... ];`, `args = [ ... ] ++ extra;`, an indented string):
      // keep the whole statement verbatim, re-indented relative to its key. The single-line
      // passthrough below would keep only the first line and emit broken Nix.
      const openField = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(\S[\s\S]*)$/);
      if (openField && !statementComplete(trimmed)) {
        const keyIndent = line.length - line.trimStart().length;
        const statement = [trimmed];
        while (lineIndex + 1 < lines.length && !statementComplete(statement.join('\n'))) {
          lineIndex++;
          const next = lines[lineIndex];
          const nextIndent = next.length - next.trimStart().length;
          statement.push(next.trim() ? next.slice(Math.min(keyIndent, nextIndent)) : '');
        }
        const value = statement.join('\n').replace(/^[a-zA-Z_][a-zA-Z0-9_-]*\s*=\s*/, '').replace(/\s*;\s*$/, '');
        (currentConfig as Record<string, unknown>)[`__raw__${openField[1]}`] = value;
        continue;
      }

      // passthrough fields (any other key = value;)
      const passthroughMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*([^;]+)\s*;?\s*$/);
      if (passthroughMatch) {
        const key = passthroughMatch[1];
        const value = passthroughMatch[2].trim();
        // Store passthrough fields as raw Nix expressions (preserving original syntax)
        // Known simple types are still parsed for merge semantics
        if (value === 'true' || value === 'false') {
          (currentConfig as Record<string, unknown>)[key] = value === 'true';
        } else if (value.startsWith('"') && value.endsWith('"')) {
          (currentConfig as Record<string, unknown>)[key] = value.slice(1, -1);
        } else {
          // Store raw Nix expression for unknown passthrough types
          (currentConfig as Record<string, unknown>)[`__raw__${key}`] = value;
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

  // Function args: union, keeping the highest layer's order and appending args only a
  // lower layer has (as mergePackages does). Whole argument texts are kept, highest
  // layer wins, so a `?` default survives.
  const argSources = new Map<string, string>();
  for (const p of parsed) {
    for (const name of p.argNames) argSources.set(name, collapseArgWhitespace(p.argSources.get(name) ?? name));
  }
  const functionArgs = orderedUnion(parsed.map((p) => p.argNames)).map((name) => argSources.get(name) ?? name);
  const hasEllipsis = parsed.some((p) => p.hasEllipsis);

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
      if (config.name !== undefined) {
        existing.name = config.name;
        delete (existing as Record<string, unknown>).__raw__name;
      }
      if (config.description !== undefined) {
        existing.description = config.description;
        delete (existing as Record<string, unknown>).__raw__description;
      }
      if (config.entry !== undefined) {
        existing.entry = config.entry;
        delete (existing as Record<string, unknown>).__raw__entry;
      }
      if (config.files !== undefined) {
        existing.files = config.files;
        delete (existing as Record<string, unknown>).__raw__files;
      }
      if (config.language !== undefined) {
        existing.language = config.language;
        delete (existing as Record<string, unknown>).__raw__language;
      }
      if (config.package !== undefined) {
        existing.package = config.package;
        delete (existing as Record<string, unknown>).__raw__package;
      }

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
          // Dedupe raw vs non-raw variants of the same key
          if (key.startsWith('__raw__')) {
            const realKey = key.slice(7);
            delete (existing as Record<string, unknown>)[realKey];
          } else {
            delete (existing as Record<string, unknown>)[`__raw__${key}`];
          }
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

  return prettyPrint(functionArgs, hasEllipsis, mergePreludes(parsed.map((p) => p.prelude)), src, mergedHooks, mergedRec);
}

/** `let` bindings are unioned with per-name last-writer-wins; a binding only a lower layer has is kept. */
function mergePreludes(preludes: ParsedPrelude[]): ParsedPrelude {
  const highest = preludes[preludes.length - 1];
  const order = orderedUnion(preludes.map((p) => [...p.bindings.keys()]));
  const bindings = new Map<string, LetBinding>();
  for (const name of order) {
    for (let i = preludes.length - 1; i >= 0; i--) {
      const binding = preludes[i].bindings.get(name);
      if (binding) {
        bindings.set(name, binding);
        break;
      }
    }
  }
  return {
    hasLet: preludes.some((p) => p.hasLet),
    leadingComment: highest.leadingComment,
    bindings,
    trailingComment: highest.trailingComment,
    rest: highest.rest,
  };
}

// ─── Pretty Print ────────────────────────────────────────────────────────────

function prettyPrint(
  functionArgs: string[],
  hasEllipsis: boolean,
  prelude: ParsedPrelude,
  src: string,
  hooks: Map<string, HookConfig>,
  hasRec: Map<string, boolean>,
): string {
  const lines: string[] = [];

  lines.push(...printFunctionHead(functionArgs, hasEllipsis));

  if (prelude.hasLet) {
    for (const comment of prelude.leadingComment) lines.push(comment);
    lines.push('let');
    for (const binding of prelude.bindings.values()) lines.push(...printLetBinding(binding));
    for (const comment of prelude.trailingComment) lines.push(comment ? `  ${comment}` : '');
    lines.push('in');
  }
  if (prelude.rest) {
    lines.push(prelude.rest);
  }

  // pre-commit-lib.run { ... }
  lines.push('pre-commit-lib.run {');
  lines.push(`  src = ${src};`);
  lines.push('');
  lines.push('  hooks = {');

  // Sort hooks alphabetically
  const sortedHookNames = [...hooks.keys()].sort(compareCodeUnits);

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

      const pushRaw = (key: string, value: string): void => {
        const [first, ...rest] = value.split('\n');
        lines.push(`      ${key} = ${first}`);
        for (const extra of rest) lines.push(extra ? `      ${extra}` : '');
        lines[lines.length - 1] += ';';
      };

      for (const key of fieldOrder) {
        emittedKeys.add(key);
        const raw = config[`__raw__${key}`];
        if (typeof raw === 'string') {
          emittedKeys.add(`__raw__${key}`);
          pushRaw(key, raw);
        } else if (key === 'excludes' && config.excludes) {
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
        if (key.startsWith('__raw__')) continue; // handled separately below
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
      // Emit raw Nix passthrough fields (stored with __raw__ prefix)
      for (const key of Object.keys(config).sort()) {
        if (!key.startsWith('__raw__') || emittedKeys.has(key)) continue;
        const value = config[key];
        if (typeof value === 'string') pushRaw(key.slice(7), value);
      }

      lines.push('    };');
    }
  }

  lines.push('  };');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}
