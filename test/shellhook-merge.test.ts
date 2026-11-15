import { test, expect, describe } from 'bun:test';
import { resolver } from '../index.ts';

/*
 * The shellHook merge rule for nix/shells.nix (owner ruling, 2026-11-15).
 *
 * The merger MERGES and never drops a hook by shell name: there is no special case for
 * `ci`, `cd`, `releaser` or any other shell. Same-name shells from two layers are joined:
 *   - either side has `inherit shellHook;`  → the merged shell has it
 *   - neither side has it                    → the merged shell has none
 * Shells with different names stay separate, each keeping exactly what it declared.
 *
 * Why it matters: a workspace's ci, cd and releaser shells carry no hook, while the
 * default developer shell does — and the CI pre-commit job runs in that default shell.
 */

const HEAD = '{\n  pkgs,\n  packages,\n  env,\n  shellHook,\n}:\nwith env;\n';

type Shell = { name: string; hook: boolean };

function shellsFile(shells: Shell[]): string {
  const body = shells
    .map(
      ({ name, hook }) =>
        `  ${name} = pkgs.mkShell {\n    buildInputs = main;\n${hook ? '    inherit shellHook;\n' : ''}  };\n`,
    )
    .join('');
  return `${HEAD}{\n${body}}\n`;
}

async function merge(parent: Shell[], child: Shell[]): Promise<string> {
  const files = [
    { path: 'nix/shells.nix', content: shellsFile(parent), origin: { layer: 0, template: 'parent' } },
    { path: 'nix/shells.nix', content: shellsFile(child), origin: { layer: 1, template: 'child' } },
  ];
  return (await resolver({ config: {}, files } as never)).content;
}

/** The body of one shell in the merged output. */
function shellBody(output: string, name: string): string {
  const match = output.match(new RegExp(`\\n  ${name} = pkgs\\.mkShell \\{\\n([\\s\\S]*?)\\n  \\};`));
  if (!match) throw new Error(`shell "${name}" missing from output:\n${output}`);
  return match[1];
}

const hasHook = (output: string, name: string) => shellBody(output, name).includes('inherit shellHook;');

// The rule must hold for every shell name alike, including the ones workspaces leave bare.
const NAMES = ['default', 'ci', 'cd', 'releaser', 'release'];

describe('same-name shells: the hook is the union of both sides', () => {
  for (const name of NAMES) {
    test(`${name}: both have the hook → merged has it`, async () => {
      expect(hasHook(await merge([{ name, hook: true }], [{ name, hook: true }]), name)).toBe(true);
    });

    test(`${name}: only the parent has it → merged has it`, async () => {
      expect(hasHook(await merge([{ name, hook: true }], [{ name, hook: false }]), name)).toBe(true);
    });

    test(`${name}: only the child has it → merged has it`, async () => {
      expect(hasHook(await merge([{ name, hook: false }], [{ name, hook: true }]), name)).toBe(true);
    });

    test(`${name}: neither has it → merged has none`, async () => {
      expect(hasHook(await merge([{ name, hook: false }], [{ name, hook: false }]), name)).toBe(false);
    });
  }

  test('the hook appears once, not once per layer', async () => {
    const output = await merge([{ name: 'default', hook: true }], [{ name: 'default', hook: true }]);
    expect(shellBody(output, 'default').match(/shellHook/g)).toHaveLength(1);
  });
});

describe('different-name shells stay separate', () => {
  test('each shell keeps exactly what its own layer declared', async () => {
    const output = await merge([{ name: 'default', hook: true }], [{ name: 'ci', hook: false }]);
    expect(hasHook(output, 'default')).toBe(true);
    expect(hasHook(output, 'ci')).toBe(false);
  });

  test('a hook on one shell does not spread to another', async () => {
    const output = await merge([{ name: 'ci', hook: false }], [{ name: 'default', hook: true }]);
    expect(hasHook(output, 'default')).toBe(true);
    expect(hasHook(output, 'ci')).toBe(false);
  });

  test('the workspace shape: hooked default, bare ci/cd/releaser', async () => {
    const parent: Shell[] = [
      { name: 'default', hook: true },
      { name: 'ci', hook: false },
    ];
    const child: Shell[] = [
      { name: 'default', hook: true },
      { name: 'cd', hook: false },
      { name: 'releaser', hook: false },
    ];
    const output = await merge(parent, child);
    expect(hasHook(output, 'default')).toBe(true);
    for (const name of ['ci', 'cd', 'releaser']) expect(hasHook(output, name)).toBe(false);
  });
});
