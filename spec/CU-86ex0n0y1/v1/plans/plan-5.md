# Plan 5: packages.nix — Registry Merge

## Goal

Implement the packages.nix parser and merger.

## Files to Modify/Create

- `cyan/src/merge-packages.ts` — packages.nix parser and merger

## Approach

### Input structure (per file)
```nix
{ pkgs, pkgs-2505, atomi }:
let
  all = rec {
    atomipkgs = (
      with atomi;
      rec {

        dotnetlint = atomi.dotnetlint.override { dotnetPackage = nix-2505.dotnet; };
        helmlint = atomi.helmlint.override { helmPackage = infrautils; };

        inherit
          infrautils
          atomiutils
          infralint
          pls
          sg;
      }
    );
    nix-2505 = (
      with pkgs-2505;
      {
        dotnet = dotnet-sdk;
        inherit
          bun

          infisical
          git
          k6

          # linter
          treefmt
          gitlint
          shellcheck;
      }
    );
  };
in
with all;
nix-2505 //
atomipkgs


```

### Parse strategy

1. Extract function args — parse identifiers from `{ ... }:` line into a set
2. Find `let` block, parse `all = rec { ... };` containing sub-blocks
3. For each sub-block:
   - Extract sub-block name (key before `=`)
   - Detect `with <registry>;` and `rec` keyword
   - Classify entries within the sub-block:
     - `inherit` blocks: multi-line or single-line
     - Bare assignments: `name = value;`
     - Override calls: `name = expr.override { ... };`
4. Parse final merge line: `with all;\n block1 //\n block2`

### Merge strategy

1. **Function args**: concat all arg identifiers across versions, dedupe, sort (NOT fail)
2. **Sub-blocks**: merge by name
   - `inherit` lines: concat identifiers, dedupe, sort
   - Named assignments (bare + overrides): **LWW by LHS key name** (highest layer wins)
   - `rec` keyword: include if any input uses it
3. **Final merge line**: concat sub-block names with `//`, dedupe, sort
4. Empty sub-blocks preserved
5. LWW override referencing lower-layer package: risk accepted

### Pretty-print output

```nix
{ atomi, pkgs, pkgs-2505 }:
let
  all = rec {
    atomipkgs = (
      with atomi;
      rec {
        dotnetlint = atomi.dotnetlint.override { dotnetPackage = nix-2505.dotnet; };

        inherit
          atomiutils
          infralint
          infrautils
          pls
          sg;
      }
    );

    nix-2505 = (
      with pkgs-2505;
      {
        dotnet = dotnet-sdk;

        inherit
          bun
          git
          infisical
          k6
          treefmt;
      }
    );
  };
in
with all;
nix-2505 //
atomipkgs
```

- Function args sorted alphabetically
- Sub-blocks sorted alphabetically
- Blank line between sub-blocks
- `inherit` one identifier per line, sorted alphabetically
- Blank lines between entries within sub-blocks (before inherit, after assignments)
- Comments from highest layer preserved
- Parenthesized `with` blocks
- Final merge line: `block1 //\n block2` (sorted alphabetically)
- Trailing newline

## Testing Strategy

- Single file passthrough
- Two files, same sub-block, different inherit lines → merged and sorted
- Two files, same sub-block, same assignment LHS → LWW
- New sub-block from one template → included
- Function args from different inputs → concat + dedupe + sort
- Final merge line → concat sub-block names, dedupe, sort
- Empty sub-block preserved
- Commutativity (swap input order → identical output)

## Implementation Checklist

- [ ] Implement `cyan/src/merge-packages.ts` with parse + merge + pretty-print
- [ ] Add packages.nix route to `index.ts` dispatch (replace stub)
- [ ] Add test cases for packages.nix
- [ ] Verify commutativity
- [ ] Run `cyanprint test resolver .` — packages.nix tests pass
