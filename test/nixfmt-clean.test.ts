import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { assertNoLoss } from '../cyan/src/loss-guard.ts';
import { mergeFlake } from '../cyan/src/merge-flake.ts';
import { mergeFmt } from '../cyan/src/merge-fmt.ts';
import { mergePackages } from '../cyan/src/merge-packages.ts';
import { mergePrecommit } from '../cyan/src/merge-precommit.ts';
import { mergeShells } from '../cyan/src/merge-shells.ts';

/*
 * U1/U2/U3/U5 — merged Nix must parse AND be nixfmt-clean, and keep the highest layer's
 * ordering. Every input below is itself nixfmt-clean, so any `nixfmt --check` failure is the
 * merger's printer. The nixfmt checks skip when nixfmt is not on PATH; the parse checks and
 * the structural assertions always run.
 */

type Merge = (files: { content: string; layer: number; template: string }[]) => string;

function run(file: string, merge: Merge, ...contents: string[]): string {
  const output = merge(contents.map((content, layer) => ({ content, layer, template: `template-${layer}` })));
  assertNoLoss(file, contents, output);
  return output;
}

function expectParseableNix(content: string): void {
  const result = Bun.spawnSync(['nix-instantiate', '--parse', '--expr', content]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

const nixfmt = Bun.which('nixfmt');

function expectNixfmtClean(content: string): void {
  expectParseableNix(content);
  if (!nixfmt) return;
  const result = Bun.spawnSync([nixfmt, '--check', '-'], { stdin: new TextEncoder().encode(content) });
  if (result.exitCode !== 0) {
    const formatted = Bun.spawnSync([nixfmt, '-'], { stdin: new TextEncoder().encode(content) });
    throw new Error(`not nixfmt-clean:\n${content}\n--- nixfmt would print ---\n${formatted.stdout.toString()}`);
  }
}

const PACKAGES_A = `{
  pkgs,
  atomi,
}:
let
  all = rec {
    atomipkgs = (
      with atomi;
      rec {
        inherit
          infrautils
          pls
          ;
      }
    );
  };
in
with all;
atomipkgs
`;

const PACKAGES_B = `{
  pkgs-2505,
  pkgs-unstable,
  atomi,
}:
let
  all = rec {
    atomipkgs = (
      with atomi;
      rec {
        inherit
          sg
          ;
      }
    );

    nix-2505 = (
      with pkgs-2505;
      {
        dotnet = dotnet-sdk;
      }
    );

    nix-unstable = (
      with pkgs-unstable;
      {
        inherit
          bun
          ;
      }
    );
  };
in
with all;
nix-2505 // nix-unstable // atomipkgs
`;

const SHELLS_A = `{
  pkgs,
  packages,
  env,
  shellHook,
}:
with env;
{
  default = pkgs.mkShell {
    buildInputs = system ++ main ++ lint;
    inherit shellHook;
  };
}
`;

const SHELLS_B = `{
  pkgs,
  packages,
  env,
  shellHook,
}:
with env;
{
  default = pkgs.mkShell {
    buildInputs = system ++ dev ++ main ++ infra;
    inherit shellHook;
  };
}
`;

const PRECOMMIT_A = `{
  formatter,
  packages,
  pre-commit-lib,
}:
let
  runtime = "high";
in
pre-commit-lib.run {
  src = ./.;

  hooks = {
    shared = {
      enable = true;
      entry = "\${runtime}/bin/high";
    };
  };
}
`;

const PRECOMMIT_B = `{
  packages,
  pre-commit-lib,
  extra,
}:
let
  runtime = "low";
  helper = "lower-only";
in
pre-commit-lib.run {
  src = ./.;

  hooks = {
    lower = {
      enable = true;
      entry = "\${helper}/bin/lower";
    };

    shared = {
      enable = true;
      entry = "\${runtime}/bin/low";
    };
  };
}
`;

const FMT_A = `{
  pkgs,
  treefmt-nix,
  ...
}:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      shfmt.enable = true;
    };
  };
in
(treefmt-nix.mkWrapper pkgs fmt)
`;

// Layers run lowest to highest in array order: the LAST content is the highest layer.
describe('U1 merged output is nixfmt-clean', () => {
  test('packages', () => {
    const output = run('nix/packages.nix', mergePackages, PACKAGES_A, PACKAGES_B);
    expect(output.startsWith('{\n  pkgs-2505,\n  pkgs-unstable,\n  atomi,\n  pkgs,\n}:\n')).toBe(true);
    expectNixfmtClean(output);
  });

  test('shells', () => {
    expectNixfmtClean(run('nix/shells.nix', mergeShells, SHELLS_A, SHELLS_B));
  });

  test('pre-commit', () => {
    expectNixfmtClean(run('nix/pre-commit.nix', mergePrecommit, PRECOMMIT_A, PRECOMMIT_B));
  });

  test('fmt', () => {
    expectNixfmtClean(run('nix/fmt.nix', mergeFmt, FMT_A, FMT_A));
  });

  test('a long // chain stays on one line while it fits', () => {
    const output = run('nix/packages.nix', mergePackages, PACKAGES_A, PACKAGES_B);
    expect(output).toContain('\natomipkgs // nix-2505 // nix-unstable\n');
  });
});

describe('U2 mergeShells keeps the highest layer order', () => {
  test('buildInputs are not sorted; lower-only items are appended', () => {
    const output = run('nix/shells.nix', mergeShells, SHELLS_A, SHELLS_B);
    expect(output).toContain('buildInputs = system ++ dev ++ main ++ infra ++ lint;');
  });

  test('when every layer agrees the order is unchanged', () => {
    const output = run('nix/shells.nix', mergeShells, SHELLS_B, SHELLS_B);
    expect(output).toContain('buildInputs = system ++ dev ++ main ++ infra;');
  });

  test('reversed layers flip which order wins', () => {
    const output = run('nix/shells.nix', mergeShells, SHELLS_B, SHELLS_A);
    expect(output).toContain('buildInputs = system ++ main ++ lint ++ dev ++ infra;');
  });
});

describe('U3 mergePrecommit unions args and let bindings', () => {
  test('function args are unioned', () => {
    const output = run('nix/pre-commit.nix', mergePrecommit, PRECOMMIT_A, PRECOMMIT_B);
    for (const arg of ['formatter', 'packages', 'pre-commit-lib', 'extra']) {
      expect(output).toMatch(new RegExp(`^  ${arg},$`, 'm'));
    }
  });

  test('let bindings are unioned; the highest (last) layer wins per name', () => {
    const output = run('nix/pre-commit.nix', mergePrecommit, PRECOMMIT_A, PRECOMMIT_B);
    expect(output).toContain('runtime = "low";');
    expect(output).not.toContain('runtime = "high";');
    expect(output).toContain('helper = "lower-only";');
  });

  test('a top layer with fewer let bindings no longer throws', () => {
    expect(() => run('nix/pre-commit.nix', mergePrecommit, PRECOMMIT_B, PRECOMMIT_A)).not.toThrow();
  });
});

describe('U5 mergeFlake prints inserted inherits nixfmt-style', () => {
  const root = join(import.meta.dir, '..', 'inputs', 'flake_merge_diff_registries');

  test('growing a compact inherit past three names explodes it', async () => {
    // The fixtures are not valid Nix on their own (`pre-commit-lib` is unbound); bind it away so the merge can be parsed.
    const read = async (name: string) =>
      (await Bun.file(join(root, name, 'flake.nix')).text()).replace('inherit packages pre-commit-lib formatter;', 'inherit packages formatter;');
    const a = await read('template-a');
    const b = await read('template-b');
    const output = run('flake.nix', mergeFlake, a, b);
    expectParseableNix(output);
    expect(output).not.toMatch(/inherit(?: [\w'-]+){4,};/);
    expect(output).toMatch(/inherit\n(\s+[\w-]+\n)+\s+;/);
  });
});

describe('mergePrecommit keeps a multi-line hook value whole', () => {
  const base = (hook: string) => `{
  packages,
  pre-commit-lib,
}:
let
  validators = commands: builtins.concatStringsSep " && " commands;
in
pre-commit-lib.run {
  src = ./.;

  hooks = {
${hook}
  };
}
`;
  const withList = base(`    pins = {
      enable = true;
      entry = validators [
        "scripts/a.sh one"
        "scripts/a.sh two"
      ];
      language = "system";
    };`);
  const withString = base(`    pins = {
      enable = true;
      entry = "scripts/low.sh";
      language = "system";
    };`);

  test('entry = f [ ... ] survives, parses and is nixfmt-clean', () => {
    const output = run('nix/pre-commit.nix', mergePrecommit, withString, withList);
    expect(output).toContain('entry = validators [\n        "scripts/a.sh one"\n        "scripts/a.sh two"\n      ];');
    expectNixfmtClean(output);
  });

  test('a higher plain-string entry replaces a lower multi-line one', () => {
    const output = run('nix/pre-commit.nix', mergePrecommit, withList, withString);
    expect(output).toContain('entry = "scripts/low.sh";');
    expect(output).not.toContain('validators [');
    expectNixfmtClean(output);
  });

  test('re-merging the output is a fixed point', () => {
    const once = run('nix/pre-commit.nix', mergePrecommit, withList);
    expect(run('nix/pre-commit.nix', mergePrecommit, once)).toBe(once);
  });
});
