// Standalone test to verify mergePrecommit behavior
import { mergePrecommit } from '../cyan/src/merge-precommit.ts';

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

// Test 1: merge_disjoint — all hooks from both templates present
console.log('Test 1: merge_disjoint — all hooks from both templates');
{
  const templateA = `{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ././;

  hooks = {
    a-helm-lint = {
      enable = true;
      name = "Lint Helm Charts";
      package = packages.infralint;
      description = "Lints helm charts";
      entry = "\${package}/bin/helmlint";
      files = "infra/.*";
      language = "system";
      pass_filenames = false;
    };

    a-infisical = {
      enable = true;
      name = "Secrets Scanning";
      description = "Scan for possible secrets";
      entry = "\${packages.infisical}/bin/infisical scan . --verbose";
      language = "system";
      pass_filenames = false;
    };
  };
}
`;

  const templateB = `{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ././;

  hooks = {
    shellcheck.enable = false;

    treefmt = {
      enable = true;
      package = formatter;
      excludes = [
        "infra/.*chart.*/templates/.*(yaml|yml)"
      ];
    };
  };
}
`;

  const result = mergePrecommit([
    { content: templateA, layer: 0, template: 'template-a' },
    { content: templateB, layer: 1, template: 'template-b' },
  ]);

  console.log(result);
  assert(result.includes('a-helm-lint'), 'a-helm-lint present');
  assert(result.includes('a-infisical'), 'a-infisical present');
  assert(result.includes('shellcheck'), 'shellcheck present');
  assert(result.includes('treefmt'), 'treefmt present');
}

// Test 2: merge_overlap — excludes concat + dedupe
console.log('\nTest 2: merge_overlap — excludes concat + dedupe');
{
  const templateA = `{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ././;

  hooks = {
    treefmt = {
      enable = true;
      package = formatter;
      excludes = [
        "infra/.*chart.*/templates/.*(yaml|yml)"
        "infra/.*chart.*/.*(MD|md)"
      ];
    };
  };
}
`;

  const templateB = `{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ././;

  hooks = {
    shellcheck.enable = false;

    treefmt = {
      enable = true;
      package = formatter;
      excludes = [
        "infra/.*chart.*/templates/.*(yaml|yml)"
      ];
    };

    a-helm-lint = rec {
      enable = true;
      name = "Lint Helm Charts";
      package = packages.infralint;
      description = "Lints helm charts";
      entry = "\${package}/bin/helmlint";
      files = "infra/.*";
      language = "system";
      pass_filenames = false;
    };
  };
}
`;

  const result = mergePrecommit([
    { content: templateA, layer: 0, template: 'template-a' },
    { content: templateB, layer: 1, template: 'template-b' },
  ]);

  console.log(result);
  assert(result.includes('infra/.*chart.*/templates/.*(yaml|yml)'), 'first exclude present');
  assert(result.includes('infra/.*chart.*/.*(MD|md)'), 'second exclude present (concat+dedupe)');
  assert(result.includes('rec'), 'rec keyword preserved from template-b');
}

// Test 3: conflicting_enable — enable=true wins
console.log('\nTest 3: conflicting_enable — enable=true wins');
{
  const templateA = `{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ././;

  hooks = {
    shellcheck = {
      enable = true;
      name = "Shellcheck";
      description = "Shell script linter";
      entry = "shellcheck";
      language = "system";
      pass_filenames = true;
    };
  };
}
`;

  const templateB = `{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ././;

  hooks = {
    shellcheck.enable = false;

    treefmt = {
      enable = true;
      package = formatter;
      excludes = [
        "infra/.*chart.*/templates/.*(yaml|yml)"
      ];
    };

    a-helm-lint = {
      enable = true;
      name = "Lint Helm Charts";
      package = packages.infralint;
      description = "Lints helm charts";
      entry = "\${package}/bin/helmlint";
      files = "infra/.*";
      language = "system";
      pass_filenames = false;
    };
  };
}
`;

  const result = mergePrecommit([
    { content: templateA, layer: 0, template: 'template-a' },
    { content: templateB, layer: 1, template: 'template-b' },
  ]);

  console.log(result);
  // shellcheck should have enable=true (true wins over false)
  // But in this case, template-a has enable=true in multi-line, template-b has enable=false in single-line
  // enable=true should win
  const shellcheckMatch = result.match(/shellcheck[^}]*enable\s*=\s*(true|false)/s);
  assert(shellcheckMatch && shellcheckMatch[1] === 'true', 'shellcheck enable=true wins');
}

// Test 4: commutativity
console.log('\nTest 4: commutativity — swap order → identical output');
{
  const templateA = `{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ././;

  hooks = {
    shellcheck.enable = false;
  };
}
`;

  const templateB = `{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ././;

  hooks = {
    a-infisical = {
      enable = true;
      name = "Secrets Scanning";
      description = "Scan for possible secrets";
      entry = "\${packages.infisical}/bin/infisical scan . --verbose";
      language = "system";
      pass_filenames = false;
    };

    treefmt = {
      enable = true;
      package = formatter;
      excludes = [
        ".*(Changelog|README).+(MD|md)"
      ];
    };
  };
}
`;

  const resultAB = mergePrecommit([
    { content: templateA, layer: 0, template: 'template-a' },
    { content: templateB, layer: 1, template: 'template-b' },
  ]);

  const resultBA = mergePrecommit([
    { content: templateB, layer: 0, template: 'template-b' },
    { content: templateA, layer: 1, template: 'template-a' },
  ]);

  assert(resultAB === resultBA, 'commutativity: AB === BA');
  console.log('AB output:');
  console.log(resultAB);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
