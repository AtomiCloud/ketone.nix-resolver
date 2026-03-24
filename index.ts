import { type ResolverOutput, StartResolverWithLambda, type ResolverInput } from '@atomicloud/cyan-sdk';
import { mergeFlake } from './cyan/src/merge-flake.ts';
import { mergeEnv } from './cyan/src/merge-env.ts';
import { mergeFmt } from './cyan/src/merge-fmt.ts';
import { mergePrecommit } from './cyan/src/merge-precommit.ts';

type MergeFn = (sortedFiles: { content: string; layer: number; template: string }[]) => string;

const LWW: MergeFn = (sortedFiles) => sortedFiles[sortedFiles.length - 1].content;

const MERGERS: Record<string, MergeFn> = {
  'flake.nix': mergeFlake,
  'nix/env.nix': mergeEnv,
  'nix/fmt.nix': mergeFmt,
  'nix/packages.nix': LWW,
  'nix/shells.nix': LWW,
  'nix/pre-commit.nix': mergePrecommit,
};

StartResolverWithLambda(async (input: ResolverInput): Promise<ResolverOutput> => {
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

  // If no specific merger found, fall back to LWW (highest layer wins)
  const content = merger
    ? merger(
        sorted.map((f) => ({
          content: f.content,
          layer: f.origin.layer,
          template: f.origin.template,
        })),
      )
    : sorted[sorted.length - 1].content;

  return { path, content };
});
