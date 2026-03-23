# Plan 4: pre-commit.nix — Deep Merge Hooks

## Goal

Implement the pre-commit.nix parser and merger.

## Files to Modify/Create

- `cyan/src/merge-precommit.ts` — pre-commit.nix parser and merger

## Approach

### Input structure (per file)
```nix
{ packages, formatter, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;

  # hooks
  hooks = {


    shellcheck.enable = false;

    treefmt = {
      enable = true;
      package = formatter;
      excludes = [
        "infra/.*chart.*/templates/.*(yaml|yml)"
        "infra/.*chart.*/.*(MD|md)"
        ".*(Changelog|README).+(MD|md)"
      ];
    };

    a-helm-lint = rec {
      enable = true;
      name = "Lint Helm Charts";
      package = packages.infralint;
      description = "Lints helm charts";
      entry = "${package}/bin/helmlint";
      files = "infra/.*";
      language = "system";
      pass_filenames = false;
    };

    a-dotnet-lint = {
      enable = true;
      name = "Lint .NET";
      description = "Run linter for .NET Projects";
      entry = "${packages.dotnetlint}/bin/dotnetlint";
      language = "system";
      pass_filenames = false;
      files = "^.*\\.cs$";
    };

    a-infisical = {
      enable = true;
      name = "Secrets Scanning";
      description = "Scan for possible secrets";
      entry = "${packages.infisical}/bin/infisical scan . --verbose";
      language = "system";
      pass_filenames = false;
    };
  };
}
```

### Parse strategy

1. Extract function args line
2. Detect `pre-commit-lib.run {` wrapper
3. Extract `src` value
4. Extract `hooks` attrset — each key is a hook name
5. For each hook, detect `rec` keyword and classify fields:
   - `enable` (boolean)
   - String fields: `name`, `description`, `entry`, `files`, `language`, `package`
   - Array fields: `excludes`, `stages`
   - Boolean fields: `pass_filenames`
   - Other fields: passthrough (preserve as raw string from highest layer)

### Merge strategy

1. Function args: exact match — **fail if different**
2. `src`: **highest layer wins**
3. `hooks`: deep merge per hook key
   - `enable` (boolean): `true` wins over `false`
   - Arrays (`excludes`, `stages`): **concat + dedupe**
   - String fields (`name`, `entry`, `files`, `language`): **highest layer wins**
   - Boolean fields (`pass_filenames`): **highest layer wins**
   - `rec` keyword: include if any input uses it
   - Unknown fields: **passthrough, highest layer wins**

### Pretty-print output

```nix
{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;

  hooks = {
    a-dotnet-lint = {
      enable = true;
      name = "Lint .NET";
      description = "Run linter for .NET Projects";
      entry = "${packages.dotnetlint}/bin/dotnetlint";
      language = "system";
      pass_filenames = false;
      files = "^.*\\.cs$";
    };

    a-helm-lint = rec {
      enable = true;
      name = "Lint Helm Charts";
      package = packages.infralint;
      description = "Lints helm charts";
      entry = "${package}/bin/helmlint";
      files = "infra/.*";
      language = "system";
      pass_filenames = false;
    };

    a-infisical = {
      enable = true;
      name = "Secrets Scanning";
      description = "Scan for possible secrets";
      entry = "${packages.infisical}/bin/infisical scan . --verbose";
      language = "system";
      pass_filenames = false;
    };

    shellcheck.enable = false;

    treefmt = {
      enable = true;
      package = formatter;
      excludes = [
        "infra/.*chart.*/templates/.*(yaml|yml)"
        "infra/.*chart.*/.*(MD|md)"
        ".*(Changelog|README).+(MD|md)"
      ];
    };
  };
}
```

- Function args sorted alphabetically
- Hooks sorted alphabetically
- Blank line between hooks
- Single-line hooks kept compact: `name.enable = false;`
- Multi-line hooks with 2-space indent
- `enable` first in multi-line hooks
- Remaining fields sorted alphabetically (description, entry, files, language, name, package, pass_filenames)
- Array fields (`excludes`, `stages`): one item per line, indented
- Trailing newline

## Testing Strategy

- Single file passthrough
- Multiple hooks from different templates → all present
- Same hook key conflicting config → deep merge per field rules
- `excludes` concat + dedupe → all entries from all layers merged
- `enable = true` vs `enable = false` → `true` wins
- `rec` preserved when present in any input
- Commutativity (swap input order → identical output)

## Implementation Checklist

- [ ] Implement `cyan/src/merge-precommit.ts` with parse + merge + pretty-print
- [ ] Add pre-commit.nix route to `index.ts` dispatch (replace stub)
- [ ] Add test cases for pre-commit.nix
- [ ] Verify commutativity
- [ ] Run `cyanprint test resolver .` — pre-commit.nix tests pass
