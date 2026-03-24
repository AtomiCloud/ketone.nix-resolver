// Regenerate pre-commit snapshots from actual input files
import { mergePrecommit } from '../cyan/src/merge-precommit.ts';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const BASE = import.meta.dir.replace(/\/scripts$/, '');
const INPUTS = join(BASE, 'inputs');
const SNAPSHOTS = join(BASE, 'snapshots');

interface ResolverInput {
  path: string;
  origin: { template: string; layer: number };
}

interface TestCase {
  name: string;
  resolver_inputs: ResolverInput[];
  snapshotPath: string;
}

// Define all pre-commit test cases
const tests: TestCase[] = [
  {
    name: 'precommit_single_file',
    resolver_inputs: [
      { path: 'precommit_single_file/template-a', origin: { template: 'template-a', layer: 0 } },
    ],
    snapshotPath: 'precommit_single_file',
  },
  {
    name: 'precommit_merge_disjoint',
    resolver_inputs: [
      { path: 'precommit_merge_disjoint/template-a', origin: { template: 'template-a', layer: 0 } },
      { path: 'precommit_merge_disjoint/template-b', origin: { template: 'template-b', layer: 1 } },
    ],
    snapshotPath: 'precommit_merge_disjoint',
  },
  {
    name: 'precommit_merge_overlap',
    resolver_inputs: [
      { path: 'precommit_merge_overlap/template-a', origin: { template: 'template-a', layer: 0 } },
      { path: 'precommit_merge_overlap/template-b', origin: { template: 'template-b', layer: 1 } },
    ],
    snapshotPath: 'precommit_merge_overlap',
  },
  {
    name: 'precommit_conflicting_enable',
    resolver_inputs: [
      { path: 'precommit_conflicting_enable/template-a', origin: { template: 'template-a', layer: 0 } },
      { path: 'precommit_conflicting_enable/template-b', origin: { template: 'template-b', layer: 1 } },
    ],
    snapshotPath: 'precommit_conflicting_enable',
  },
  {
    name: 'precommit_rec_preserved',
    resolver_inputs: [
      { path: 'precommit_rec_preserved/template-a', origin: { template: 'template-a', layer: 0 } },
      { path: 'precommit_rec_preserved/template-b', origin: { template: 'template-b', layer: 1 } },
    ],
    snapshotPath: 'precommit_rec_preserved',
  },
  {
    name: 'precommit_commutativity',
    resolver_inputs: [
      { path: 'precommit_commutativity/template-a', origin: { template: 'template-a', layer: 0 } },
      { path: 'precommit_commutativity/template-b', origin: { template: 'template-b', layer: 1 } },
    ],
    snapshotPath: 'precommit_commutativity',
  },
  {
    name: 'precommit_commutativity_reversed',
    resolver_inputs: [
      { path: 'precommit_commutativity/template-b', origin: { template: 'template-b', layer: 1 } },
      { path: 'precommit_commutativity/template-a', origin: { template: 'template-a', layer: 0 } },
    ],
    snapshotPath: 'precommit_commutativity', // same snapshot as commutativity
  },
];

for (const test of tests) {
  console.log(`Processing: ${test.name}`);

  // Read all input files and find the pre-commit.nix file
  const sortedFiles = test.resolver_inputs
    .map((input) => {
      const precommitPath = join(INPUTS, input.path, 'nix', 'pre-commit.nix');
      if (!existsSync(precommitPath)) {
        throw new Error(`File not found: ${precommitPath}`);
      }
      const content = readFileSync(precommitPath, 'utf-8');
      return {
        content,
        layer: input.origin.layer,
        template: input.origin.template,
      };
    })
    .sort((a, b) => {
      if (a.layer !== b.layer) return a.layer - b.layer;
      return a.template.localeCompare(b.template);
    });

  // Run merge
  const result = mergePrecommit(sortedFiles);

  // Write snapshot
  const snapshotDir = join(SNAPSHOTS, test.snapshotPath, 'nix');
  mkdirSync(snapshotDir, { recursive: true });
  const snapshotFile = join(snapshotDir, 'pre-commit.nix');
  writeFileSync(snapshotFile, result, 'utf-8');

  console.log(`  Written: ${snapshotFile}`);
}

console.log('\nDone! All pre-commit snapshots regenerated.');
