import { test, expect, describe } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { resolver } from '../index.ts';

/*
 * Idempotence — the @3 fixed-point test class.
 *
 * A merger that is not a fixed point on its own output is a merger that is still
 * rewriting the file every time the cascade runs: the second pass is either losing
 * something the first pass kept, or inventing something the first pass did not have.
 * Both were real. `parsePackages` and `parseShells` matched a function head only when it
 * fit on line 1, so a treefmt-formatted file merged to a headless skeleton — and the
 * skeleton then merged to itself quite happily, which is precisely why nothing in the
 * suite noticed. The fixed-point property is what makes that observable.
 *
 * This is a *class*, not a list: it walks `inputs/` and covers every dispatch-table file
 * that exists, so a fixture added later is tested without anyone remembering to wire it
 * up. Three properties per file:
 *
 *   1. self-merge of one variation succeeds and loses nothing (the loss guard in
 *      index.ts throws if it does);
 *   2. re-merging that output is byte-identical — the fixed point;
 *   3. merging two identical variations agrees with merging one, so the merge of a file
 *      with a copy of itself is also the file.
 */

const INPUTS = join(import.meta.dir, '..', 'inputs');

const DISPATCH_TABLE = new Set([
  'flake.nix',
  'nix/env.nix',
  'nix/fmt.nix',
  'nix/packages.nix',
  'nix/shells.nix',
  'nix/pre-commit.nix',
]);

/*
 * Fixtures that are *supposed* to be refused. Each one is a shape the merger cannot
 * represent, and the @3 ruling is that such a shape refuses loudly rather than emitting a
 * skeleton. They are listed by fixture directory so that a fixture becoming
 * unexpectedly mergeable — or an ordinary fixture starting to throw — fails this test.
 */
const EXPECTED_REFUSALS = new Map<string, RegExp>([
  ['fmt_unknown_key', /unknown top-level key/],
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

interface Subject {
  fixture: string;
  label: string;
  dispatchPath: string;
  content: string;
}

function subjects(): Subject[] {
  const found: Subject[] = [];
  for (const absolute of walk(INPUTS).sort()) {
    // inputs/<fixture>/<template>/<dispatch path>
    const segments = relative(INPUTS, absolute).split(sep);
    if (segments.length < 3) continue;
    const dispatchPath = segments.slice(2).join('/');
    if (!DISPATCH_TABLE.has(dispatchPath)) continue;
    found.push({
      fixture: segments[0],
      label: `${segments[0]}/${segments[1]}/${dispatchPath}`,
      dispatchPath,
      content: readFileSync(absolute, 'utf8'),
    });
  }
  return found;
}

function variation(path: string, content: string, layer: number, template: string) {
  return { path, content, origin: { layer, template } };
}

const ALL = subjects();

test('the fixture tree actually contains dispatch-table files to test', () => {
  // Guards against the walker silently matching nothing, which would make every
  // assertion below vacuous — the exact failure mode this whole test class exists for.
  expect(ALL.length).toBeGreaterThan(30);
  for (const path of DISPATCH_TABLE) {
    expect(ALL.some((subject) => subject.dispatchPath === path)).toBe(true);
  }
});

describe('self-merge is a fixed point', () => {
  for (const subject of ALL) {
    const refusal = EXPECTED_REFUSALS.get(subject.fixture);

    if (refusal) {
      test(`${subject.label} refuses`, async () => {
        const attempt = resolver({
          files: [variation(subject.dispatchPath, subject.content, 0, 'template-a')],
        } as never);
        await expect(attempt).rejects.toThrow(refusal);
      });
      continue;
    }

    test(subject.label, async () => {
      const once = await resolver({
        files: [variation(subject.dispatchPath, subject.content, 0, 'template-a')],
      } as never);
      expect(once.path).toBe(subject.dispatchPath);
      expect(once.content.trim().length).toBeGreaterThan(0);

      // (2) Re-merging the merged output changes nothing.
      const twice = await resolver({
        files: [variation(subject.dispatchPath, once.content, 0, 'template-a')],
      } as never);
      expect(twice.content).toBe(once.content);

      // (3) A file merged with a copy of itself is the same file.
      const withCopy = await resolver({
        files: [
          variation(subject.dispatchPath, subject.content, 0, 'template-a'),
          variation(subject.dispatchPath, subject.content, 1, 'template-b'),
        ],
      } as never);
      expect(withCopy.content).toBe(once.content);
    });
  }
});
