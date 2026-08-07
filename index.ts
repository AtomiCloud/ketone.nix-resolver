import type { ResolverInput, ResolverOutput } from '@cyanprint/sdk';
import { mergeFlake } from './cyan/src/merge-flake.ts';
import { mergeEnv } from './cyan/src/merge-env.ts';
import { mergeFmt } from './cyan/src/merge-fmt.ts';
import { mergePrecommit } from './cyan/src/merge-precommit.ts';
import { mergePackages } from './cyan/src/merge-packages.ts';
import { mergeShells } from './cyan/src/merge-shells.ts';

type MergeFn = (sortedFiles: { content: string; layer: number; template: string }[]) => string;

const MERGERS: Record<string, MergeFn> = {
  'flake.nix': mergeFlake,
  'nix/env.nix': mergeEnv,
  'nix/fmt.nix': mergeFmt,
  'nix/packages.nix': mergePackages,
  'nix/shells.nix': mergeShells,
  'nix/pre-commit.nix': mergePrecommit,
};

export async function resolver(input: ResolverInput): Promise<ResolverOutput> {
  const { files } = input;

  if (files.length === 0) throw new Error('Resolver received no files — at least 1 file is required');

  const uniquePaths = new Set(files.map((f) => f.path));
  if (uniquePaths.size > 1)
    throw new Error(
      `Resolver received files with different paths: ${[...uniquePaths].join(', ')} — all files must have the same path`,
    );

  const path = files[0].path;

  // Sort for commutativity (layer ascending, then template name)
  const sorted = [...files].sort((a, b) => {
    if (a.origin.layer !== b.origin.layer) return a.origin.layer - b.origin.layer;
    return a.origin.template.localeCompare(b.origin.template);
  });

  // Extract basename and dispatch
  const basename = path.split('/').pop() ?? path;
  const fullRelPath = path.includes('/') ? path : basename;

  // Try basename first, then full relative path
  const merger = MERGERS[basename] ?? MERGERS[fullRelPath];

  const variations = sorted.map((f) => ({
    content: f.content,
    layer: f.origin.layer,
    template: f.origin.template,
  }));

  // A merger exists for this path: perform the structural merge.
  if (merger) {
    return { path, content: merger(variations) };
  }

  // Uncontested out-of-table path (a single variation): pass it through. The runtime
  // never invokes a resolver for a single variation — it records `added` — so this
  // branch only fires under the test harness and must not throw.
  if (variations.length === 1) {
    return { path, content: variations[0].content };
  }

  // A contested path (2+ differing variations) outside the dispatch table: REFUSE.
  // The runtime records `resolver-merged` for any resolver call that returns content,
  // so silently returning last-write-wins bytes here would stamp a merge that was never
  // performed — a provenance lie (RESOLVERS.md §6.4). Throwing propagates through
  // resolveLayers before that decision is recorded, so the wrong value can't be produced.
  throw new Error(
    `atomi/nix has no merger for "${path}" but received ${variations.length} variations. ` +
      `The path is outside the dispatch table (${Object.keys(MERGERS).join(', ')}); ` +
      `merging it would silently last-write-wins while recording resolver-merged. ` +
      `Add a merger for this path, or remove it from the resolver's files: globs.`,
  );
}
