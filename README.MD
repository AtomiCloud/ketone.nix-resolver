# atomi/nix

AtomiCloud's nix merger

## Purpose

Deep-merges Nix configuration files when multiple templates or layers contribute files to the same path. The resolver parses known Nix files into structured data and merges entries across layers. A single variation outside the dispatch table passes through unchanged; contested out-of-table paths refuse instead of silently applying last-write-wins while claiming a structural merge.

## Configuration Schema

This resolver requires no configuration.

## Resolution Strategy

The resolver dispatches to a file-type-specific merger based on the file's basename or relative path:

| File Pattern         | Merger           | Strategy                                                                                                                                                 |
| -------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flake.nix`          | `mergeFlake`     | Base-preserving merge: highest-layer text retained; missing inputs, output arguments, registries, and package inherits inserted                          |
| `nix/env.nix`        | `mergeEnv`       | Category union: deduplicate and sort packages within each category                                                                                       |
| `nix/fmt.nix`        | `mergeFmt`       | Deep merge: programs (enable true-wins, extra_args LWW), projectRootFile LWW                                                                             |
| `nix/packages.nix`   | `mergePackages`  | Sub-block merge: function args (union), inherit IDs (LWW per identifier), assignments (LWW)                                                              |
| `nix/shells.nix`     | `mergeShells`    | Shell merge: buildInputs (union, dedupe, sort) per shell name                                                                                            |
| `nix/pre-commit.nix` | `mergePrecommit` | Deep merge: equal function args, highest-layer `let` prelude and `src`, hook union, enable true-wins, string fields LWW, array fields concat+dedupe       |
| any other path       | fallback         | Single variation passes through; contested variations refuse                                                                                            |

### Field-level merge rules

| Rule              | Applies to                                                                            |
| ----------------- | ------------------------------------------------------------------------------------- |
| Union + dedupe    | Input names, output params, function args, buildInputs, inherit IDs, excludes, stages |
| Highest-layer LWW | Input URLs and their attached comments                                                |
| Enable true-wins  | fmt programs, pre-commit hooks                                                        |
| String LWW        | src, projectRootFile, hook name/description/entry/files/language/package              |
| Boolean LWW       | pass_filenames, fmt extra_args                                                        |
| Array concat      | excludes, stages                                                                      |

## Commutativity and Associativity

The resolver ensures deterministic output regardless of input ordering:

- **Files are sorted** by layer number (ascending), then template name (alphabetical) before merging
- **Unioned collections** are deduplicated via `Set`; flake content keeps the highest layer's order and inserts missing lower-layer members in a deterministic order
- **LWW fields** always use the value from the highest layer, which is stable regardless of input order
- **True-wins booleans** produce the same result whether processed in any order (`a || b` is commutative)
- **Flake comments and unmodelled syntax** remain byte-for-byte from the highest layer; comments for lower-only input and output entries travel with the inserted entries
- **Flake output binders** retain their actual `@alias`, union every declared argument, preserve `...`, and are checked against the merged input names before returning
- **Conflicting registries** in packages.nix sub-blocks throw an error rather than silently choosing

## Merge Examples

### Example 1: flake.nix input merge

**Input files** (both `flake.nix`):

| Origin Template | Origin Layer | Content                                                    |
| --------------- | ------------ | ---------------------------------------------------------- |
| base            | 0            | `inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";` |
| infra           | 1            | `inputs.flake-utils.url = "github:numtide/flake-utils";`   |

**Resolved output**:

```
inputs = {
    flake-utils.url = "github:numtide/flake-utils";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
  };
```

### Example 2: nix/env.nix category union

**Input files** (both `nix/env.nix`):

| Origin Template | Origin Layer | Content                                         |
| --------------- | ------------ | ----------------------------------------------- |
| base            | 0            | `{ pkgs }: { dev = [ nodejs_22 typescript ]; }` |
| frontend        | 1            | `{ pkgs }: { dev = [ nodejs_22 eslint ]; }`     |

**Resolved output**:

```
{ pkgs }:
{
  dev = [
    eslint
    nodejs_22
    typescript
  ];
}
```

### Example 3: nix/shells.nix buildInputs union

**Input files** (both `nix/shells.nix`):

| Origin Template | Origin Layer | Content                                                      |
| --------------- | ------------ | ------------------------------------------------------------ |
| base            | 0            | Shell `default` with `buildInputs = [ pkgs.go ];`            |
| tools           | 1            | Shell `default` with `buildInputs = [ pkgs.go pkgs.gopls ];` |

**Resolved output** (deduped, sorted):

```
  default = pkgs.mkShell {
    buildInputs = pkgs.go ++ pkgs.gopls;
  };
```

### Example 4: nix/pre-commit.nix hook deep merge

**Input files** (both `nix/pre-commit.nix`):

| Origin Template | Origin Layer | Content                                                    |
| --------------- | ------------ | ---------------------------------------------------------- |
| base            | 0            | `prettier.enable = true; prettier.excludes = ["*.snap"];`  |
| frontend        | 1            | `prettier.enable = false; prettier.excludes = ["dist/*"];` |

**Resolved output** (enable true-wins, excludes concat+dedupe):

```
    prettier = {
      enable = true;
      excludes = [
        "*.snap"
        "dist/*"
      ];
    };
```

### Example 5: Unknown contested paths refuse

**Input files** (both `nix/overlay.nix`):

| Origin Template | Origin Layer | Content                                |
| --------------- | ------------ | -------------------------------------- |
| base            | 0            | `self: super: { }`                     |
| custom          | 1            | `self: super: { go = super.go_1_22; }` |

**Result**: the resolver throws an error naming `nix/overlay.nix` and the dispatch table. It does not return last-write-wins content, so the runtime cannot record `resolver-merged` for a merge that never happened.

## Verification

Run the complete local gate from the resolver root:

```bash
bun run test
```

The Bun tests invoke `nix-instantiate --parse` on the exact real
workspace/bun-base composition and on adversarial binder shapes; the CyanPrint
suite then verifies all resolver snapshots.

## Integration

Reference this resolver in a template's `cyan.yaml`:

```yaml
resolvers:
  - ref: atomi/nix@2
    config: {}
    files: ['**/*.nix']
```
