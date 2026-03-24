// Standalone test script to verify error paths in mergeEnv and mergeFmt
// The cyanprint test framework only supports snapshot tests, so error/throws
// scenarios cannot be tested via test.cyan.yaml. This script provides
// evidence that the error paths work correctly.

import { mergeEnv } from '../cyan/src/merge-env.ts';
import { mergeFmt } from '../cyan/src/merge-fmt.ts';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}`);
    failed++;
  }
}

console.log('=== Error Path Verification ===\n');

// Test 1: Function args mismatch should throw (ENV)
console.log('Test 1: ENV Function args mismatch throws error');
try {
  mergeEnv([
    { content: '{ pkgs, packages }:\nwith packages;\n{\n  dev = [\n    git\n  ];\n}\n', layer: 0, template: 'template-a' },
    { content: '{ pkgs, packages, extra }:\nwith packages;\n{\n  dev = [\n    git\n  ];\n}\n', layer: 1, template: 'template-b' },
  ]);
  assert(false, 'Should have thrown error for args mismatch');
} catch (e) {
  assert(e instanceof Error && e.message.includes('function args mismatch'), `Error thrown with correct message: "${(e as Error).message}"`);
}

// Test 2: with packages; mismatch should throw (ENV)
console.log('\nTest 2: ENV with packages; mismatch throws error');
try {
  mergeEnv([
    { content: '{ pkgs, packages }:\nwith packages;\n{\n  dev = [\n    git\n  ];\n}\n', layer: 0, template: 'template-a' },
    { content: '{ pkgs, packages }:\n{\n  dev = [\n    git\n  ];\n}\n', layer: 1, template: 'template-b' },
  ]);
  assert(false, 'Should have thrown error for with packages mismatch');
} catch (e) {
  assert(e instanceof Error && e.message.includes('with packages'), `Error thrown with correct message: "${(e as Error).message}"`);
}

// Test 3: Inline comments are stripped from package names (ENV)
console.log('\nTest 3: ENV Inline comments stripped from package names');
const result = mergeEnv([
  { content: '{ pkgs, packages }:\nwith packages;\n{\n  dev = [\n    git # version control\n    pls\n  ];\n}\n', layer: 0, template: 'template-a' },
]);
assert(result.includes('    git\n'), 'Package "git" present without comment');
assert(!result.includes('git #'), 'Inline comment stripped from "git"');
assert(result.includes('    pls\n'), 'Package "pls" present');

// Test 4: Full-line comments are skipped (ENV)
console.log('\nTest 4: ENV Full-line comments are skipped');
const result2 = mergeEnv([
  { content: '{ pkgs, packages }:\nwith packages;\n{\n  dev = [\n    # a comment line\n    git\n  ];\n}\n', layer: 0, template: 'template-a' },
]);
assert(result2.includes('    git\n'), 'Package "git" present after comment line');
assert(!result2.includes('#'), 'Comment line not present in output');

// Test 5: FMT Function args mismatch should throw
console.log('\nTest 5: FMT Function args mismatch throws error');
try {
  mergeFmt([
    {
      content: `{ pkgs, treefmt-nix, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";
    programs = {
      nixpkgs-fmt.enable = true;
    };
  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper`,
      layer: 0,
      template: 'template-a',
    },
    {
      content: `{ pkgs, custom-tool, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";
    programs = {
      prettier.enable = true;
    };
  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper`,
      layer: 1,
      template: 'template-b',
    },
  ]);
  assert(false, 'Should have thrown error for args mismatch');
} catch (e) {
  assert(e instanceof Error && e.message.includes('function args mismatch'), `Error thrown with correct message: "${(e as Error).message}"`);
}

// Test 6: FMT Unknown top-level key should throw
console.log('\nTest 6: FMT Unknown top-level key throws error');
try {
  mergeFmt([
    {
      content: `{ pkgs, treefmt-nix, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";
    unknownSetting = "foo";
    programs = {
      nixpkgs-fmt.enable = true;
    };
  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper`,
      layer: 0,
      template: 'template-a',
    },
  ]);
  assert(false, 'Should have thrown error for unknown key');
} catch (e) {
  assert(e instanceof Error && e.message.includes('unknown top-level key'), `Error thrown with correct message: "${(e as Error).message}"`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
