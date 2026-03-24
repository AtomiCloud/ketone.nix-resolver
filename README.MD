# atomi/nix

AtomiCloud's nix merger

## Purpose

Deep-merges Nix configuration files when multiple templates or layers contribute files to the same path. The resolver parses Nix files into structured data, merges entries across layers, and pretty-prints the result. Files not matching a known pattern fall back to last-write-wins (highest layer).

## Configuration Schema

This resolver requires no configuration.

## Resolution Strategy

The resolver dispatches to a file-type-specific merger based on the file's basename or relative path:

| File Pattern       | Merger          | Strategy                                                                                   |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------ |
| `flake.nix`        | `mergeFlake`    | Deep merge: inputs (URL LWW), outputs (union), registries (expr LWW), packages inherit (union) |
| `nix/env.nix`      | `mergeEnv`      | Category union: deduplicate and sort packages within each category                         |
| `nix/fmt.nix`      | `mergeFmt`      | Deep merge: programs (enable true-wins, extra\_args LWW), projectRootFile LWW              |
| `nix/packages.nix` | `mergePackages` | Sub-block merge: function args (union), inherit IDs (LWW per identifier), assignments (LWW) |
| `nix/shells.nix`   | `mergeShells`   | Shell merge: buildInputs (union, dedupe, sort) per shell name                              |
| `nix/pre-commit.nix` | `mergePrecommit` | Deep merge: hooks (enable true-wins, string fields LWW, array fields concat+dedupe)     |
| any other `.nix`   | fallback        | Last-write-wins: highest layer wins                                                        |

### Field-level merge rules

| Rule               | Applies to                                       |
| ------------------ | ------------------------------------------------ |
| Union + dedupe     | Input URLs, output params, function args, buildInputs, inherit IDs, excludes, stages |
| Enable true-wins   | fmt programs, pre-commit hooks                    |
| String LWW         | src, projectRootFile, hook name/description/entry/files/language/package |
| Boolean LWW        | pass\_filenames, fmt extra\_args                  |
| Array concat       | excludes, stages                                 |

## Commutativity and Associativity

The resolver ensures deterministic output regardless of input ordering:

- **Files are sorted** by layer number (ascending), then template name (alphabetical) before merging
- **Unioned collections** (inputs, outputs, packages, inherit IDs) are deduplicated via `Set` and sorted alphabetically on output
- **LWW fields** always use the value from the highest layer, which is stable regardless of input order
- **True-wins booleans** produce the same result whether processed in any order (`a || b` is commutative)
- **Comment groups** are preserved from the first layer that defines them (not reordered by re-processing)
- **Conflicting registries** in packages.nix sub-blocks throw an error rather than silently choosing

## Merge Examples

### Example 1: flake.nix input merge

**Input files** (both `flake.nix`):

| Origin Template | Origin Layer | Content                                  |
| --------------- | ------------ | ---------------------------------------- |
| base            | 0            | `inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";` |
| infra           | 1            | `inputs.flake-utils.url = "github:numtide/flake-utils";` |

**Resolved output**:

```
inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    flake-utils.url = "github:numtide/flake-utils";
  };
```

### Example 2: nix/env.nix category union

**Input files** (both `nix/env.nix`):

| Origin Template | Origin Layer | Content                                  |
| --------------- | ------------ | ---------------------------------------- |
| base            | 0            | `{ pkgs }: { dev = [ nodejs_22 typescript ]; }` |
| frontend        | 1            | `{ pkgs }: { dev = [ nodejs_22 eslint ]; }` |

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

| Origin Template | Origin Layer | Content                                  |
| --------------- | ------------ | ---------------------------------------- |
| base            | 0            | Shell `default` with `buildInputs = [ pkgs.go ];` |
| tools           | 1            | Shell `default` with `buildInputs = [ pkgs.go pkgs.gopls ];` |

**Resolved output** (deduped, sorted):

```
  default = pkgs.mkShell {
    buildInputs = pkgs.go ++ pkgs.gopls;
  };
```

### Example 4: nix/pre-commit.nix hook deep merge

**Input files** (both `nix/pre-commit.nix`):

| Origin Template | Origin Layer | Content                                  |
| --------------- | ------------ | ---------------------------------------- |
| base            | 0            | `prettier.enable = true; prettier.excludes = ["*.snap"];` |
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

### Example 5: Fallback LWW for unknown .nix files

**Input files** (both `nix/overlay.nix`):

| Origin Template | Origin Layer | Content                                  |
| --------------- | ------------ | ---------------------------------------- |
| base            | 0            | `self: super: { }`                        |
| custom          | 1            | `self: super: { go = super.go_1_22; }`   |

**Resolved output** (highest layer wins):

```
self: super: { go = super.go_1_22; }
```

## Integration

Reference this resolver in a template's `cyan.yaml`:

```yaml
resolvers:
  - resolver: atomi/nix:version
    config: {}
    files: ['**/*.nix']
```
