import { describe, expect, test } from 'bun:test';
import { assertNoLoss } from './loss-guard.ts';
import { mergeFmt } from './merge-fmt.ts';

function variation(content: string, layer = 0, template = 'template-a') {
  return { content, layer, template };
}

/** Merge under the @3 loss guard, exactly as index.ts wires it. */
function merge(...contents: string[]): string {
  const files = contents.map((content, index) => variation(content, index, `template-${index}`));
  const output = mergeFmt(files);
  assertNoLoss('nix/fmt.nix', contents, output);
  return output;
}

function expectParseableNix(content: string): void {
  const result = Bun.spawnSync(['nix-instantiate', '--parse', '--expr', content]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

/** Merging the merged output again must reproduce it byte for byte. */
function expectFixedPoint(output: string): void {
  expect(merge(output)).toBe(output);
  expect(merge(output, output)).toBe(output);
}

// A `let` binding beside `fmt` that contains its own `let ... in`. Before the depth-aware
// scanner the parser took the FIRST bare `in` after the fmt block — the one belonging to
// `helper` — so `letSuffix` was truncated to `helper = let a = 1;` and `tail` became
// `a;\nin\n(treefmt-nix...)`. The output had two `in` keywords and did not parse.
const SIBLING_NESTED_LET = `{ pkgs, treefmt-nix, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      shfmt.enable = true;
    };
  };
  helper = let a = 1; in a;
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
`;

// A `fmt` attribute nested inside an earlier binding. The old plain search matched it
// before the real top-level `fmt`, so the merger parsed the wrong attribute set.
const NESTED_FMT_ATTRIBUTE = `{ pkgs, treefmt-nix, ... }:
let
  helper = { fmt = { bogus = true; }; };
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      shfmt.enable = true;
    };
  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
`;

// A `let ... in` in value position inside the fmt block. Its `;` is not the end of the
// binding, so the entry scanner has to pair `let` with `in` as well.
const NESTED_LET_IN_VALUE = `{ pkgs, treefmt-nix, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      shfmt = {
        enable = true;
        extra_args = let base = [ "-i" ]; in base;
      };
    };
  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
`;

describe('mergeFmt — nested let/in', () => {
  test('a sibling `let ... in` binding does not steal the closing `in`', () => {
    const output = merge(SIBLING_NESTED_LET);

    expectParseableNix(output);
    expect(output).toContain('helper = let a = 1; in a;');
    expect(output.trimEnd().endsWith('(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper')).toBe(true);
    // Exactly one `in` closes the outer `let`; the doubled `in` was the visible symptom.
    expect(output.split('\n').filter((line) => line.trim() === 'in')).toHaveLength(1);
    expectFixedPoint(output);
  });

  test('a nested `fmt` attribute is not mistaken for the top-level binding', () => {
    const output = merge(NESTED_FMT_ATTRIBUTE);

    expectParseableNix(output);
    expect(output).toContain('projectRootFile = "flake.nix";');
    expect(output).toContain('shfmt.enable = true;');
    expect(output).toContain('helper = { fmt = { bogus = true; }; };');
    expectFixedPoint(output);
  });

  test('a `let ... in` in value position does not end the binding at its `;`', () => {
    const output = merge(NESTED_LET_IN_VALUE);

    expectParseableNix(output);
    expect(output).toContain('extra_args = let base = [ "-i" ]; in base;');
    expectFixedPoint(output);
  });

  test('nested-let inputs still merge with a plain layer', () => {
    const plain = `{ pkgs, treefmt-nix, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      nixfmt.enable = true;
    };
  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
`;
    const output = merge(plain, SIBLING_NESTED_LET);

    expectParseableNix(output);
    expect(output).toContain('nixfmt.enable = true;');
    expect(output).toContain('shfmt.enable = true;');
    expect(output).toContain('helper = let a = 1; in a;');
    expectFixedPoint(output);
  });
});

/** A fmt.nix whose `nixfmt` program carries `field` alongside `enable`. */
function withProgramField(field: string): string {
  return `{ pkgs, treefmt-nix, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      nixfmt = {
        enable = true;
        ${field}
      };
      shfmt.enable = true;
    };
  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
`;
}

describe('mergeFmt — `with` / `assert` preludes in a value', () => {
  // The value scan ended at the first depth-zero `;`, which for `with pkgs; foo;` is the
  // one closing the prelude. The remainder was then read as a new attribute entry and
  // the merger refused a perfectly valid file, blaming the wrong thing:
  // "unrecognised entry starting \"nixfmt-rfc-style;\"".
  const preludes: Record<string, string> = {
    'with': 'package = with pkgs; nixfmt-rfc-style;',
    'assert': 'package = assert pkgs != null; pkgs.nixfmt;',
    'two stacked preludes': 'package = with pkgs; with pkgs.lib; nixfmt-rfc-style;',
    'a prelude followed by a nested let': 'package = with pkgs; let p = nixfmt; in p;',
  };

  for (const [name, field] of Object.entries(preludes)) {
    test(`${name} does not end the binding at the prelude's semicolon`, () => {
      const output = merge(withProgramField(field));

      expectParseableNix(output);
      expect(output).toContain(field);
      // The binding after the one carrying the prelude must still be parsed.
      expect(output).toContain('shfmt.enable = true;');
      expectFixedPoint(output);
    });
  }

  test('a prelude inside a list item is left alone', () => {
    const output = merge(withProgramField('extra_args = [ (with pkgs; "-i") ];'));

    expectParseableNix(output);
    expect(output).toContain('extra_args = [ (with pkgs; "-i") ];');
    expectFixedPoint(output);
  });

  test('a value carrying a prelude is last-write-wins across layers', () => {
    const output = merge(
      withProgramField('package = with pkgs; nixfmt-rfc-style;'),
      withProgramField('package = with pkgs; nixfmt-classic;'),
    );

    expectParseableNix(output);
    expect(output).toContain('package = with pkgs; nixfmt-classic;');
    expect(output).not.toContain('nixfmt-rfc-style');
    expectFixedPoint(output);
  });
});

describe('mergeFmt — zero inputs', () => {
  // The one case the loss guard structurally cannot catch: nothing was supplied, so
  // nothing can be reported as lost. Before the guard this was a TypeError from
  // `parsed[0].functionArgs` — an implementation leak, not a merger refusal.
  test('refuses by name instead of raising a TypeError', () => {
    let caught: unknown;
    try {
      mergeFmt([]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe(
      'Cannot merge nix/fmt.nix: no files were provided; at least one is required.',
    );
  });
});
