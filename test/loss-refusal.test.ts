import { test, expect, describe } from 'bun:test';
import { resolver } from '../index.ts';
import { mergePackages } from '../cyan/src/merge-packages.ts';
import { mergeEnv } from '../cyan/src/merge-env.ts';
import { mergeFmt } from '../cyan/src/merge-fmt.ts';
import { mergeShells } from '../cyan/src/merge-shells.ts';
import {
  assertNoLoss,
  findFunctionHeader,
  inventoryMaterial,
  withLossGuard,
} from '../cyan/src/loss-guard.ts';

/*
 * The @3 loss-refusal invariant.
 *
 * Before @3 only mergeFlake checked that its inputs survived. The other five mergers
 * parsed into a model and printed the model back, so a shape the model did not cover was
 * dropped silently and the resolver still exited success — the worst possible outcome,
 * because a caller has no signal at all. The ruling: every merger refuses instead, naming
 * what went missing.
 *
 * Two proven instances are pinned below as regressions. Both were found on 2026-08-09
 * against the diene cascade's shared node.
 */

function variation(path: string, content: string, layer = 0, template = 'template-a') {
  return { path, content, origin: { layer, template } };
}

describe('findFunctionHeader', () => {
  test('parses a single-line head', () => {
    expect(findFunctionHeader('{ pkgs, packages }:\n{}')?.args).toEqual(['pkgs', 'packages']);
  });

  test('parses the multi-line head treefmt produces', () => {
    // The shape that defeated parsePackages and parseShells: both anchored their regex to
    // line 1, so this returned no arguments at all and the printer emitted `{ }:`.
    const head = '{\n  atomi,\n  pkgs-2605,\n  pkgs-unstable,\n}:\nnull';
    expect(findFunctionHeader(head)?.args).toEqual(['atomi', 'pkgs-2605', 'pkgs-unstable']);
  });

  test('parses defaults and ellipsis without treating them as names', () => {
    const header = findFunctionHeader('{ pkgs, system ? "x86_64-linux", ... }:\nnull');
    expect(header?.args).toEqual(['pkgs', 'system']);
    expect(header?.hasEllipsis).toBe(true);
  });

  test('refuses a file that does not begin with an argument set', () => {
    expect(findFunctionHeader('let x = 1; in x')).toBeNull();
  });
});

describe('inventoryMaterial', () => {
  test('collects args, bindings, inherits and with-preludes', () => {
    const inventory = inventoryMaterial('{ pkgs, env }:\nwith env;\n{\n  cd = pkgs.mkShell {\n    inherit shellHook;\n  };\n}\n');
    expect([...inventory.args].sort()).toEqual(['env', 'pkgs']);
    expect(inventory.bindings.has('cd')).toBe(true);
    expect([...inventory.inherited]).toEqual(['shellHook']);
    expect([...inventory.withPreludes]).toEqual(['env']);
  });

  test('does not count names inside comments or string literals', () => {
    // Without masking, a commented-out binding or a shell fragment inside an `entry`
    // string would become material the merger is forever obliged to carry.
    const inventory = inventoryMaterial('{ pkgs }:\n# ghost = 1;\n{\n  real = "decoy = 2;";\n}\n');
    expect(inventory.bindings.has('ghost')).toBe(false);
    expect(inventory.bindings.has('decoy')).toBe(false);
    expect(inventory.bindings.has('real')).toBe(true);
  });
});

describe('assertNoLoss', () => {
  const input = '{ pkgs, env }:\nwith env;\n{\n  cd = pkgs.mkShell {\n    inherit shellHook;\n  };\n}\n';

  test('accepts an output that keeps everything', () => {
    expect(() => assertNoLoss('nix/shells.nix', [input], input)).not.toThrow();
  });

  test('names a dropped function argument', () => {
    expect(() => assertNoLoss('nix/shells.nix', [input], input.replace('{ pkgs, env }:', '{ pkgs }:'))).toThrow(
      /function argument 'env'/,
    );
  });

  test('names a dropped with-prelude', () => {
    expect(() => assertNoLoss('nix/shells.nix', [input], input.replace('with env;\n', ''))).toThrow(
      /prelude 'with env;'/,
    );
  });

  test('names a dropped inherit', () => {
    expect(() => assertNoLoss('nix/shells.nix', [input], input.replace('    inherit shellHook;\n', ''))).toThrow(
      /inherited identifier 'shellHook'/,
    );
  });

  test('names a dropped binding', () => {
    expect(() => assertNoLoss('nix/shells.nix', [input], '{ pkgs, env }:\nwith env;\n{\n}\n')).toThrow(
      /binding 'cd'/,
    );
  });

  test('accepts a binding re-rendered as an inherit and vice versa', () => {
    // `shellHook = shellHook;` and `inherit shellHook;` are the same expression written
    // two ways; re-rendering between them is a legitimate thing for a pretty-printer to
    // do and must not read as loss. Asserted in BOTH directions — checking only one was
    // the bug that made the equivalence comment untrue of the code.
    const explicit = '{ shellHook }:\n{ shellHook = shellHook; }\n';
    const inherited = '{ shellHook }:\n{ inherit shellHook; }\n';
    expect(() => assertNoLoss('nix/x.nix', [explicit], inherited)).not.toThrow();
    expect(() => assertNoLoss('nix/x.nix', [inherited], explicit)).not.toThrow();
  });

  test('tolerates last-write-wins on a value, which is documented merge semantics', () => {
    // The invariant is about names, not right-hand sides. `dotnet` must survive; which
    // package expression won the conflict is the resolver's documented LWW rule.
    const older = '{ pkgs }:\n{\n  dotnet = dotnet-sdk;\n}\n';
    const newer = '{ pkgs }:\n{\n  dotnet = dotnet-sdk_9;\n}\n';
    expect(() => assertNoLoss('nix/packages.nix', [older, newer], newer)).not.toThrow();
  });

  test('reports every loss at once rather than the first', () => {
    let message = '';
    try {
      assertNoLoss('nix/shells.nix', [input], '{ }:\n{\n}\n');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("function argument 'env'");
    expect(message).toContain("function argument 'pkgs'");
    expect(message).toContain("prelude 'with env;'");
    expect(message).toContain("inherited identifier 'shellHook'");
    expect(message).toContain("binding 'cd'");
    expect(message).toContain('nix/shells.nix');
  });
});

describe('withLossGuard', () => {
  test('passes through an output that keeps everything', () => {
    const guarded = withLossGuard('nix/x.nix', (files) => files[0].content);
    expect(guarded([{ content: '{ a }:\n{ b = a; }\n', layer: 0, template: 't' }])).toContain('b = a;');
  });

  test('turns a lossy merger into a refusal', () => {
    const guarded = withLossGuard('nix/x.nix', () => '{ }:\n{ }\n');
    expect(() => guarded([{ content: '{ a }:\n{ b = a; }\n', layer: 0, template: 't' }])).toThrow(
      /lost .*function argument 'a'/,
    );
  });
});

describe('regression: the two @2 defects the diene cascade hit', () => {
  test('a treefmt multi-line head survives nix/packages.nix merging', async () => {
    // @2 emitted `{ }:` here — a function taking no arguments whose body referenced all
    // three of them. Unevaluable Nix, exit code 0.
    const content = [
      '{',
      '  atomi,',
      '  pkgs-2605,',
      '  pkgs-unstable,',
      '}:',
      'let',
      '  all = rec {',
      '    atomipkgs = (',
      '      with atomi;',
      '      {',
      '        inherit',
      '          atomiutils',
      '          ;',
      '      }',
      '    );',
      '    nix-unstable = (with pkgs-unstable; { });',
      '    nix-2605 = (',
      '      with pkgs-2605;',
      '      {',
      '        inherit',
      '          git',
      '          ;',
      '      }',
      '    );',
      '  };',
      'in',
      'with all;',
      'nix-2605 // nix-unstable // atomipkgs',
      '',
    ].join('\n');

    const merged = await resolver({ files: [variation('nix/packages.nix', content)] } as never);
    expect(merged.content).toStartWith('{ atomi, pkgs-2605, pkgs-unstable }:');
    expect(merged.content).not.toContain('{  }:');
  });

  test('nix/shells.nix keeps its head, its prelude and every inherit', async () => {
    // @2 emitted `{  }:` with no `with env;` and no `inherit shellHook;` in any shell.
    const content = [
      '{',
      '  pkgs,',
      '  packages,',
      '  env,',
      '  shellHook,',
      '}:',
      'with env;',
      '{',
      '  cd = pkgs.mkShell {',
      '    buildInputs = main ++ system;',
      '    inherit shellHook;',
      '  };',
      '}',
      '',
    ].join('\n');

    const merged = await resolver({ files: [variation('nix/shells.nix', content)] } as never);
    expect(merged.content).toStartWith('{ env, packages, pkgs, shellHook }:\nwith env;\n');
    expect(merged.content).toContain('inherit shellHook;');
    expect(merged.content).toContain('buildInputs = main ++ system;');
  });
});

describe('an unmodelled shape refuses instead of emitting a skeleton', () => {
  test('nix/shells.nix refuses an unknown field rather than dropping it', async () => {
    const content = '{ pkgs, env }:\nwith env;\n{\n  cd = pkgs.mkShell {\n    buildInputs = main;\n    hardeningDisable = [ "all" ];\n  };\n}\n';
    await expect(resolver({ files: [variation('nix/shells.nix', content)] } as never)).rejects.toThrow(
      /unknown field "hardeningDisable"/,
    );
  });

  test('nix/packages.nix refuses a body it cannot model rather than collapsing it', async () => {
    // The 2026-08-09 collapse shape: a `//` chain of `with`-scoped sets with no
    // `all = rec { ... }` block. @2 answered with a 42-byte skeleton and exit 0.
    const content = '{ atomi, pkgs }:\nwith pkgs;\n{ inherit git; } // (with atomi; { inherit releaser; })\n';
    await expect(resolver({ files: [variation('nix/packages.nix', content)] } as never)).rejects.toThrow(
      /`all = rec \{ \.\.\. \}` registry block was not found/,
    );
  });

  test('nix/env.nix refuses a headless file rather than emitting a bare colon', async () => {
    const content = 'with packages;\n{\n  dev = [\n    git\n  ];\n}\n';
    await expect(resolver({ files: [variation('nix/env.nix', content)] } as never)).rejects.toThrow(
      /no function argument set was found/,
    );
  });
});

describe('shells.nix inherit forms', () => {
  test('refuses `inherit (<source>) ...;` rather than re-scoping the names', async () => {
    const content = '{ pkgs, env }:\nwith env;\n{\n  cd = pkgs.mkShell {\n    buildInputs = main;\n    inherit (pkgs) hello;\n  };\n}\n';
    await expect(resolver({ files: [variation('nix/shells.nix', content)] } as never)).rejects.toThrow(
      /inherit \(<source>\) \.\.\.;/,
    );
  });

  test('keeps every plain inherited identifier, not just shellHook', async () => {
    const content = '{ pkgs, env }:\nwith env;\n{\n  cd = pkgs.mkShell {\n    buildInputs = main;\n    inherit shellHook name;\n  };\n}\n';
    const merged = await resolver({ files: [variation('nix/shells.nix', content)] } as never);
    expect(merged.content).toContain('inherit name shellHook;');
  });
});

describe('review findings — CodeRabbit, PR #10', () => {
  test('an indented string does not end early on ${} or an escaped quote', () => {
    // `'''` escapes a literal `''` and `''${` escapes an interpolation. Closing at the
    // first `''` handed the rest of a shellHook body to the scanner as Nix code, which
    // then became phantom material assertNoLoss would demand in every output.
    // Carries BOTH escapes: `''${` (escaped interpolation) and `'''` (an escaped literal
    // `''`). Exercising only one leaves the other branch unproved.
    const source = "{ pkgs }:\n{\n  hook = ''\n    echo ''${NOT_A_BINDING}\n    printf '''\n    ghost = 1;\n  '';\n}\n";
    const inventory = inventoryMaterial(source);
    expect(inventory.bindings.has('ghost')).toBe(false);
    expect(inventory.bindings.has('NOT_A_BINDING')).toBe(false);
    expect(inventory.bindings.has('hook')).toBe(true);
  });

  test('a dotted with-prelude is inventoried', () => {
    expect([...inventoryMaterial('{ pkgs }:\nwith pkgs.lib;\n{ a = 1; }\n').withPreludes]).toEqual(['pkgs.lib']);
  });

  test('`with rec { ... };` is not mistaken for a prelude', () => {
    // Widening the prelude capture to any expression would stop at the first inner `;`
    // and invent a prelude no output could ever satisfy.
    const inventory = inventoryMaterial('{ pkgs }:\nwith rec {\n  a = 1;\n};\n{ b = a; }\n');
    expect([...inventory.withPreludes]).toEqual([]);
  });

  test('a function argument default survives the round trip', async () => {
    // The name survives either way, so the loss guard cannot see this one — only an
    // explicit check can.
    const content = '{ packages, pkgs ? import <nixpkgs> { } }:\nwith packages;\n{\n  dev = [\n    git\n  ];\n}\n';
    const merged = await resolver({ files: [variation('nix/env.nix', content)] } as never);
    expect(merged.content).toStartWith('{ packages, pkgs ? import <nixpkgs> { } }:');
  });

  test('a single-line category list keeps its items and closes the category', async () => {
    // Items on the `key = [ ... ];` line were dropped, and the list stayed "open" so the
    // NEXT category's items were appended to it. Both are invisible to the loss guard:
    // package names inside a list are values, not bindings.
    const content = '{ pkgs, packages }:\nwith packages;\n{\n  dev = [ git go-task ];\n\n  lint = [ shellcheck ];\n}\n';
    const merged = await resolver({ files: [variation('nix/env.nix', content)] } as never);
    expect(merged.content).toContain('dev = [\n    git\n    go-task\n  ];');
    expect(merged.content).toContain('lint = [\n    shellcheck\n  ];');
  });

  test('buildInputs splits on ++ at depth zero only', async () => {
    const content = '{ pkgs, env }:\nwith env;\n{\n  cd = pkgs.mkShell {\n    buildInputs = (main ++ lint) ++ system;\n  };\n}\n';
    const merged = await resolver({ files: [variation('nix/shells.nix', content)] } as never);
    expect(merged.content).toContain('buildInputs = (main ++ lint) ++ system;');
  });

  test('packages.nix refuses zero inputs rather than printing the skeleton', () => {
    expect(() => mergePackages([])).toThrow(/no files were provided/);
  });

  test('a commented-out `all = rec {` does not become the registry block', async () => {
    const content = [
      '{ atomi }:',
      '# all = rec { decoy = 1; };',
      'let',
      '  all = rec {',
      '    atomipkgs = (',
      '      with atomi;',
      '      {',
      '        inherit',
      '          releaser',
      '          ;',
      '      }',
      '    );',
      '  };',
      'in',
      'with all;',
      'atomipkgs',
      '',
    ].join('\n');
    const merged = await resolver({ files: [variation('nix/packages.nix', content)] } as never);
    expect(merged.content).toContain('releaser');
    expect(merged.content).not.toContain('decoy');
  });
});

describe('review findings — round 2', () => {
  const MERGERS_FOR_TEST: Record<string, (f: { content: string; layer: number; template: string }[]) => string> = {
    'nix/env.nix': mergeEnv,
    'nix/fmt.nix': mergeFmt,
    'nix/packages.nix': mergePackages,
    'nix/shells.nix': mergeShells,
  };

  test('shells.nix accepts a dotted `with` prelude', async () => {
    // The guard learned to inventory `with pkgs.lib;` before parseShells learned to
    // accept it, which turned a valid file into a refusal — a regression introduced by
    // the fix for the previous round, caught by the next one.
    const content = '{ pkgs }:\nwith pkgs.lib;\n{\n  cd = pkgs.mkShell {\n    buildInputs = [];\n  };\n}\n';
    const merged = await resolver({ files: [variation('nix/shells.nix', content)] } as never);
    expect(merged.content).toContain('with pkgs.lib;');
  });

  test('every merger refuses zero inputs instead of throwing a TypeError', () => {
    // Zero inputs are the one case the loss guard cannot catch: nothing was supplied, so
    // nothing is missing. Each merger has to say so itself.
    for (const [path, merger] of Object.entries(MERGERS_FOR_TEST)) {
      let error: Error | undefined;
      try {
        merger([]);
      } catch (thrown) {
        error = thrown as Error;
      }
      expect(error, `${path} accepted zero inputs`).toBeDefined();
      expect(error, `${path} threw an implementation error`).not.toBeInstanceOf(TypeError);
      expect(error!.message).toMatch(/no files were provided|at least one/i);
    }
  });
});
