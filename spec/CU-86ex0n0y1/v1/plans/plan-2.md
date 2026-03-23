# Plan 2: env.nix — Package Category Merge

## Goal

Implement the env.nix parser and merger.

## Files to Modify/Create

- `cyan/src/merge-env.ts` — env.nix parser and merger

## Approach

### Input structure (per file)
```nix
{ pkgs, packages }:
with packages;
{
  system = [
    atomiutils
  ];

  dev = [
    pls
    git
  ];

  infra = [
    infrautils
  ];

  main = [
    bun
    dotnet
    infisical
    k6
  ];

  lint = [
    # core
    treefmt
    gitlint
    shellcheck
    infralint
    dotnetlint
    helmlint
    sg
  ];

  releaser = [
    sg
  ];
}
```

### Parse strategy

1. Extract function args line — match `^{.*}:` (single line)
2. Detect optional `with packages;` line
3. Parse the top-level attrset: each key maps to a list
4. For each category key: extract list items (strip whitespace, ignore empty lines and comments)

### Merge strategy

1. Function args: exact string match across all inputs — **fail if different**
2. For each category: collect all package names from all inputs, deduplicate, sort alphabetically
3. Categories from any input included
4. Empty lists preserved

### Pretty-print output

```nix
{ pkgs, packages }:
with packages;
{
  dev = [
    git
    pls
  ];

  infra = [
    infrautils
  ];

  lint = [
    # core
    dotnetlint
    gitlint
    helmlint
    infralint
    shellcheck
    sg
    treefmt
  ];

  main = [
    bun
    dotnet
    infisical
    k6
  ];

  releaser = [
    sg
  ];

  system = [
    atomiutils
  ];
}
```

- Categories sorted alphabetically
- Package names sorted alphabetically within each category
- Blank line between categories
- One package per line
- Comments preserved from highest layer (attached to the category or line)
- Trailing newline

**Note on comments:** Inline comments in package lists are tricky for commutativity. Strategy: preserve comments from the highest layer that contributed a given package. If a package only exists in lower layers, its comment is dropped (simpler approach). Alternatively, drop all comments in merged output (cleaner for deterministic output).

## Testing Strategy

- Single file passthrough
- Two files, disjoint categories → all categories present
- Two files, overlapping packages in same category → deduplicated
- Function args mismatch → error
- Empty category preserved
- New category from one file → included
- Commutativity (swap input order → identical output)

## Implementation Checklist

- [ ] Implement `cyan/src/merge-env.ts` with parse + merge + pretty-print
- [ ] Add env.nix route to `index.ts` dispatch (replace stub)
- [ ] Add test cases for env.nix
- [ ] Verify commutativity
- [ ] Run `cyanprint test resolver .` — env.nix tests pass
