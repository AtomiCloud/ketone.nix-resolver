import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mergeFlake, parseFlake } from './merge-flake.ts';

const fixtureRoot = join(
  import.meta.dir,
  '../../inputs/flake_real_workspace_bun_base',
);

async function readFixture(name: 'workspace' | 'bun-base'): Promise<string> {
  return Bun.file(join(fixtureRoot, name, 'flake.nix')).text();
}

function expectParseableNix(content: string): void {
  const result = Bun.spawnSync([
    'nix-instantiate',
    '--parse',
    '--expr',
    content,
  ]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function outputParams(content: string): string[] {
  return parseFlake(content)
    .outputParamGroups.flatMap((group) => group.items)
    .sort();
}

describe('mergeFlake outputs binding and comment preservation', () => {
  test('real authoritative workspace + bun-base remains parseable and fully bound', async () => {
    const workspace = await readFixture('workspace');
    const bunBase = await readFixture('bun-base');
    const output = mergeFlake([
      { content: workspace, layer: 0, template: 'authoritative/workspace' },
      { content: bunBase, layer: 1, template: 'authoritative/bun-base' },
    ]);

    expectParseableNix(output);
    expect(parseFlake(output).outputsAlias).toBe('inputs');
    expect(outputParams(output)).toEqual([
      'atomipkgs',
      'flake-utils',
      'nixpkgs-2605',
      'nixpkgs-unstable',
      'pre-commit-hooks',
      'self',
      'treefmt-nix',
    ]);

    // Both real files already expose the same input set. The winning file is
    // therefore preserved byte-for-byte, including every line-attached comment.
    expect(output).toBe(bunBase);
    expect(output).toContain(
      '    # NOTHING VALIDATES THIS. `v4` is retargeted at every registry release, so this\n' +
        '    # input moves within the v4 major line whenever the lock is refreshed, and\n' +
        '    # `flake.lock` alone records which commit is in force. Downstream templates\n' +
        '    # inherit this line rather than re-pinning it, so an exact tag here would pin\n' +
        '    # every child too. Unlike the nixpkgs inputs above, a moving ref is the intent.\n' +
        '    atomipkgs.url = "github:AtomiCloud/nix-registry/v4";',
    );
  });

  test('adds missing names without rewriting compact aliases or nearby comments', () => {
    const lower = `{
  inputs = {
    # lower input must travel with this line
    lower.url = "github:example/lower";
  };
  outputs = { self, lower } @lowerInputs: { marker = lower; };
}
`;
    const higher = `{
  inputs = {
    # high input remains on its original line
    high.url = "github:example/high"; # inline high comment
  };
  outputs = highInputs@{ self, high, ... }:
    # body comment must not be routed through a printer
    { marker = high; };
}
`;

    const output = mergeFlake([
      { content: lower, layer: 0, template: 'lower' },
      { content: higher, layer: 1, template: 'higher' },
    ]);

    expectParseableNix(output);
    expect(output).toContain('highInputs@{ self, high, lower, ... }:');
    expect(output).toContain(
      '# lower input must travel with this line\n    lower.url = "github:example/lower";',
    );
    expect(output).toContain(
      'high.url = "github:example/high"; # inline high comment',
    );
    expect(output).toContain(
      '# body comment must not be routed through a printer',
    );
    expect(parseFlake(output).outputsAlias).toBe('highInputs');
    expect(outputParams(output)).toEqual(['...', 'high', 'lower', 'self']);
  });

  test('inserts lower-only arguments in trailing-comma binders', () => {
    const lower = `{
  inputs = {
    # lower input
    lower.url = "github:example/lower";
  };
  outputs =
    { self
      # lower argument
    , lower
    } @inputs: { marker = lower; };
}
`;
    const higher = `{
  inputs = {
    # high input
    high.url = "github:example/high";
  };
  outputs =
    {
      self,
      # high argument
      high,
    } @inputs: { marker = high; };
}
`;

    const output = mergeFlake([
      { content: lower, layer: 0, template: 'lower' },
      { content: higher, layer: 1, template: 'higher' },
    ]);

    expectParseableNix(output);
    expect(output).toContain('      # lower argument\n      lower,');
    expect(outputParams(output)).toEqual(['high', 'lower', 'self']);
  });

  test('separates an insertion after an uncommaed trailing-style formal', () => {
    const lower = `{
  inputs = { flake-utils.url = "github:numtide/flake-utils"; };
  outputs = { self, flake-utils }: { marker = flake-utils; };
}
`;
    const higher = `{
  inputs = { nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable"; };
  outputs =
    {
      self,
      nixpkgs
    }: { marker = nixpkgs; };
}
`;

    const output = mergeFlake([
      { content: lower, layer: 0, template: 'lower' },
      { content: higher, layer: 1, template: 'higher' },
    ]);

    expectParseableNix(output);
    expect(outputParams(output)).toEqual(['flake-utils', 'nixpkgs', 'self']);
  });

  test('keeps an inherited ellipsis after every inserted formal', () => {
    const aaa = `{
  inputs = { aaa.url = "github:example/aaa"; };
  outputs =
    { self
      # aaa group
    , aaa
    , ...
    }: { marker = aaa; };
}
`;
    const zzz = `{
  inputs = { zzz.url = "github:example/zzz"; };
  outputs =
    { self
      # zzz group
    , zzz
    }: { marker = zzz; };
}
`;
    const higher = `{
  inputs = { high.url = "github:example/high"; };
  outputs = { self, high }: { marker = high; };
}
`;

    const output = mergeFlake([
      { content: aaa, layer: 0, template: 'aaa' },
      { content: zzz, layer: 1, template: 'zzz' },
      { content: higher, layer: 2, template: 'higher' },
    ]);

    expectParseableNix(output);
    const binding = output.match(/outputs\s*=([\s\S]*?):/)?.[1] ?? '';
    expect(binding.indexOf('zzz')).toBeLessThan(binding.indexOf('...'));
    expect(outputParams(output)).toEqual(['...', 'aaa', 'high', 'self', 'zzz']);
  });

  test('inserts before a trailing-style ellipsis without doubling commas', () => {
    const lower = `{
  inputs = { foo.url = "github:example/foo"; };
  outputs = { self, foo }: { marker = foo; };
}
`;
    const higher = `{
  inputs = { high.url = "github:example/high"; };
  outputs =
    {
      self,
      high,
      ...
    }: { marker = high; };
}
`;

    const output = mergeFlake([
      { content: lower, layer: 0, template: 'lower' },
      { content: higher, layer: 1, template: 'higher' },
    ]);

    expectParseableNix(output);
    const binding = output.match(/outputs\s*=([\s\S]*?):/)?.[1] ?? '';
    expect(binding.indexOf('foo')).toBeLessThan(binding.indexOf('...'));
    expect(outputParams(output)).toEqual(['...', 'foo', 'high', 'self']);
  });

  test('recognises defaulted formals instead of inserting duplicates', () => {
    const lower = `{
  inputs = { extra.url = "github:example/extra"; };
  outputs = { self, extra }: { marker = extra; };
}
`;
    const higher = `{
  inputs = { high.url = "github:example/high"; };
  outputs = { self, high, extra ? null }: { marker = high; };
}
`;

    const output = mergeFlake([
      { content: lower, layer: 0, template: 'lower' },
      { content: higher, layer: 1, template: 'higher' },
    ]);

    expectParseableNix(output);
    expect(output.match(/extra\s*\?\s*null/g)).toHaveLength(1);
    expect(outputParams(output)).toEqual(['extra', 'high', 'self']);
  });

  test('preserves a default expression inserted from a lower layer', () => {
    const lower = `{
  inputs = { foo.url = "github:example/foo"; };
  outputs = { self, foo, optional ? null }: { marker = foo; };
}
`;
    const higher = `{
  inputs = { high.url = "github:example/high"; };
  outputs = { self, high }: { marker = high; };
}
`;

    const output = mergeFlake([
      { content: lower, layer: 0, template: 'lower' },
      { content: higher, layer: 1, template: 'higher' },
    ]);

    expectParseableNix(output);
    expect(output).toContain('optional ? null');
    expect(outputParams(output)).toEqual(['foo', 'high', 'optional', 'self']);
  });

  test('is idempotent after union members have been inserted', () => {
    const lower = `{
  inputs = { lower.url = "github:example/lower"; };
  outputs = { self, lower }: { marker = lower; };
}
`;
    const higher = `{
  inputs = { high.url = "github:example/high"; };
  outputs = { self, high, ... }: { marker = high; };
}
`;
    const once = mergeFlake([
      { content: lower, layer: 0, template: 'lower' },
      { content: higher, layer: 1, template: 'higher' },
    ]);
    const twice = mergeFlake([{ content: once, layer: 1, template: 'merged' }]);

    expect(twice).toBe(once);
  });

  test('refuses to return an input that the outputs binder cannot accept', () => {
    const broken = `{
  inputs = { flake-utils.url = "github:numtide/flake-utils"; };
  outputs = { self } @inputs: flake-utils;
}
`;

    expect(() =>
      mergeFlake([{ content: broken, layer: 0, template: 'broken' }]),
    ).toThrow(
      "input 'flake-utils' is not accepted by the outputs argument set",
    );
  });
});
