import { test, expect } from 'bun:test';
import type { ResolverInput, ResolvedFile } from '@cyanprint/sdk';
import { resolver } from '../index.ts';

/*
 * Provenance regression tests for the dispatch table (RESOLVERS.md §6.4, §8.3).
 *
 * The defect: a path that matches the resolver's `files:` globs but sits OUTSIDE the
 * six-entry dispatch table used to silently last-write-wins while the runtime still
 * recorded `resolver-merged` — provenance claimed a merge that never happened. The fix
 * makes a contested out-of-table path REFUSE (throw) and leaves everything else alone.
 *
 * The runtime (sulfone.lite resolve-layers.ts) records `resolver-merged` for a path only
 * when the resolver call returns content; a throw propagates before that decision is
 * pushed. So proving the resolver throws for the out-of-table contested case is the
 * proximate proof that the wrong value can no longer be recorded.
 *
 * Every arm below holds the CONTENT fixed and varies only the PATH, so the only thing
 * that flips an outcome between "merges" and "refuses" is table membership — that is the
 * must-differ. Each refusal arm is paired with a control that mutates only the path to
 * show the same content merges once the path is in the table.
 */

// `nix/env.nix` is in the dispatch table; `nix/unknown.nix` is a plausible glob match
// (`nix/*.nix`) that is NOT in the table. `sample.txt` is a non-nix out-of-table path.
const IN_TABLE = 'nix/env.nix';
const OUT_TABLE_NIX = 'nix/unknown.nix';
const OUT_TABLE_OTHER = 'sample.txt';

// Two valid, differing env.nix variations with disjoint categories. A real merge keeps
// all four categories; a last-write-wins keeps only one variation's two.
const VARIATION_A = `{ pkgs, packages }:
with packages;
{
  system = [
    atomiutils
  ];

  dev = [
    pls
    git
  ];
}
`;
const VARIATION_B = `{ pkgs, packages }:
with packages;
{
  lint = [
    treefmt
    shellcheck
  ];

  main = [
    bun
    dotnet
  ];
}
`;

function makeInput(path: string, contents: string[]): ResolverInput {
  const files: ResolvedFile[] = contents.map((content, index) => ({
    path,
    content,
    origin: { template: `template-${index === 0 ? 'a' : 'b'}`, layer: index },
  }));
  return { config: {}, files };
}

test('inside-table contested path: resolver merges (returns content, no throw)', async () => {
  const output = await resolver(makeInput(IN_TABLE, [VARIATION_A, VARIATION_B]));
  expect(typeof output.content).toBe('string');
  expect(output.path).toBe(IN_TABLE);
  // A real merge carries BOTH variations' categories; LWW would keep only one set.
  expect(output.content).toContain('system');
  expect(output.content).toContain('dev');
  expect(output.content).toContain('lint');
  expect(output.content).toContain('main');
});

test('outside-table contested path: resolver REFUSES (throws) — the fix', async () => {
  const call = resolver(makeInput(OUT_TABLE_NIX, [VARIATION_A, VARIATION_B]));
  await expect(call).rejects.toThrow();
  await expect(call).rejects.toThrow(OUT_TABLE_NIX);
  await expect(call).rejects.toThrow('dispatch table');
});

test('outside-table single variation: passes through (no throw)', async () => {
  // The runtime records `added` for a single variation and never invokes a resolver for
  // it; this branch only fires under the test harness and must not throw.
  const output = await resolver(makeInput(OUT_TABLE_OTHER, [VARIATION_A]));
  expect(output.content).toBe(VARIATION_A);
  expect(output.path).toBe(OUT_TABLE_OTHER);
});

// Positive controls — prove each arm can go the other way by mutating ONLY the path.

test('CONTROL A: out-of-table input merges once the path is moved in-table', async () => {
  // Same content as the refusal arm; only the path changes. It must NOT throw.
  const output = await resolver(makeInput(IN_TABLE, [VARIATION_A, VARIATION_B]));
  expect(output.content).toContain('system');
  expect(output.content).toContain('lint');
});

test('CONTROL B: in-table input refuses once the path is moved out-of-table', async () => {
  // Same content as the merge arm; only the path changes. It MUST throw.
  await expect(resolver(makeInput(OUT_TABLE_NIX, [VARIATION_A, VARIATION_B]))).rejects.toThrow(
    'dispatch table',
  );
});

test('CONTROL C: a second out-of-table path (.txt) also refuses when contested', async () => {
  // The refusal is not specific to the `.nix` extension — any contested out-of-table path refuses.
  await expect(resolver(makeInput(OUT_TABLE_OTHER, [VARIATION_A, VARIATION_B]))).rejects.toThrow(
    'dispatch table',
  );
});
