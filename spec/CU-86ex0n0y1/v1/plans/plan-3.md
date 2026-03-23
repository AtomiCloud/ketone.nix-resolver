# Plan 3: fmt.nix — Deep Merge Programs

## Goal

Implement the fmt.nix parser and merger.

## Files to Modify/Create

- `cyan/src/merge-fmt.ts` — fmt.nix parser and merger

## Approach

### Input structure (per file)
```nix
{ treefmt-nix, pkgs, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    # enable or disable formatters, see https://github.com/numtide/treefmt-nix#supported-programs
    programs = {
      nixpkgs-fmt.enable = true;
      prettier.enable = true;
      shfmt.enable = true;
      actionlint.enable = true;
    };


  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper


```

### Parse strategy

1. Extract function args line
2. Find `let fmt = {` block
3. Extract `projectRootFile` — string value
4. Extract `programs` attrset:
   - Single-line: `program-name.enable = true;` → normalize to `{ enable = true; }`
   - Multi-line: `{ enable = true; extra_args = [...]; }` → parse full attrset
5. Validate no unknown top-level keys (only `projectRootFile` and `programs` allowed)
6. Extract the `in (treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper` tail

### Merge strategy

1. Function args: exact match — **fail if different**
2. `projectRootFile`: **highest layer wins**
3. `programs`: deep merge by program name
   - `enable` (boolean): `true` wins over `false`
   - `extra_args` (array): **LWW (highest layer wins)**
   - Other boolean fields: `true` wins
4. Unknown program names from any layer: include (no validation on program names)

### Pretty-print output

```nix
{ pkgs, treefmt-nix, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      actionlint.enable = true;
      nixpkgs-fmt.enable = true;
      prettier.enable = true;
      shfmt = {
        enable = true;
        extra_args = [ "--indent-switch" ];
      };
    };

  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
```

- Function args sorted alphabetically
- Programs sorted alphabetically
- Blank line between `projectRootFile` and `programs`
- Single-line programs: `name.enable = true;` (only when `enable` is the sole field)
- Multi-line programs: full attrset with 2-space indent (when has fields beyond `enable`)
- Comments from highest layer preserved
- Trailing newline

## Testing Strategy

- Single file passthrough
- Two files with different programs → all present
- Single-line vs multi-line program forms → normalized and merged
- Conflicting `enable` flags → `true` wins
- `extra_args` LWW → highest layer's array kept
- Unknown top-level key → error
- Commutativity (swap input order → identical output)

## Implementation Checklist

- [ ] Implement `cyan/src/merge-fmt.ts` with parse + merge + pretty-print
- [ ] Add fmt.nix route to `index.ts` dispatch (replace stub)
- [ ] Add test cases for fmt.nix
- [ ] Verify commutativity
- [ ] Run `cyanprint test resolver .` — fmt.nix tests pass
