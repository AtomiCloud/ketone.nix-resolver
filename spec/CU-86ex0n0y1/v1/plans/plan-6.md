# Plan 6: shells.nix — BuildInputs Concat

## Goal

Implement the shells.nix parser and merger.

## Files to Modify/Create

- `cyan/src/merge-shells.ts` — shells.nix parser and merger

## Approach

### Input structure (per file)
```nix
{ pkgs, packages, env, shellHook }:
with env;
{
  default = pkgs.mkShell {
    buildInputs = system ++ main ++ dev ++ lint ++ infra;
    inherit shellHook;
  };
  ci = pkgs.mkShell {
    buildInputs = system ++ main ++ lint ++ infra;
    inherit shellHook;
  };
  releaser = pkgs.mkShell {
    buildInputs = system ++ main ++ lint ++ infra ++ releaser;
    inherit shellHook;
  };
}
```

### Parse strategy

1. Extract function args line
2. Detect `with env;` line
3. Parse top-level attrset — each key is a shell name
4. For each shell:
   - Extract `buildInputs = ...;` line
   - Split on `++` to get individual category references
   - Strip whitespace
   - Validate no unknown fields inside shells (only `buildInputs` and `inherit shellHook`)

### Merge strategy

1. Function args: exact match — **fail if different**
2. For each shell name: concat all buildInputs entries from all inputs, dedupe, sort alphabetically
3. Shells from any input included
4. `inherit shellHook;` is assumed, not merged
5. Unknown fields inside shells → **fail**

### Pretty-print output

```nix
{ env, packages, pkgs, shellHook }:
with env;
{
  ci = pkgs.mkShell {
    buildInputs = infra ++ lint ++ main ++ system;
    inherit shellHook;
  };

  default = pkgs.mkShell {
    buildInputs = dev ++ infra ++ lint ++ main ++ system;
    inherit shellHook;
  };

  releaser = pkgs.mkShell {
    buildInputs = infra ++ lint ++ main ++ releaser ++ system;
    inherit shellHook;
  };
}
```

- Function args sorted alphabetically
- Shells sorted alphabetically
- Blank line between shells
- `buildInputs` identifiers sorted alphabetically, joined with ` ++ `
- `inherit shellHook;` indented inside mkShell block
- 2-space indent for all nesting
- Trailing newline

## Testing Strategy

- Single file passthrough
- Same shell from multiple templates → buildInputs concat + dedupe + sort
- Different shells from different templates → all included
- Function args mismatch → error
- Unknown field inside shell → error
- Commutativity (swap input order → identical output)

## Implementation Checklist

- [ ] Implement `cyan/src/merge-shells.ts` with parse + merge + pretty-print
- [ ] Add shells.nix route to `index.ts` dispatch (replace stub)
- [ ] Add test cases for shells.nix
- [ ] Verify commutativity
- [ ] Run `cyanprint test resolver .` — shells.nix tests pass
