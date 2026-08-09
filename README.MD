# atomi/nix

AtomiCloud's nix merger

## Purpose

Deep-merges Nix configuration files when multiple templates or layers contribute files to the same path. The resolver parses known Nix files into structured data and merges entries across layers. A single variation outside the dispatch table passes through unchanged; contested out-of-table paths refuse instead of silently applying last-write-wins while claiming a structural merge.

**Every merger refuses rather than losing material.** A merge that cannot carry all of its inputs through is not a merge, and the resolver throws instead of emitting a file that is quietly missing things. See [Loss refusal](#loss-refusal).

## Configuration Schema

This resolver requires no configuration.

## Resolution Strategy

The resolver dispatches to a file-type-specific merger based on the file's basename or relative path:

| File Pattern         | Merger           | Strategy                                                                                                                                                 |
| -------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flake.nix`          | `mergeFlake`     | Base-preserving merge: highest-layer text retained; missing inputs, output arguments, registries, and package inherits inserted                          |
| `nix/env.nix`        | `mergeEnv`       | Category union: deduplicate and sort packages within each category                                                                                       |
| `nix/fmt.nix`        | `mergeFmt`       | Deep merge: programs by dotted attribute path (enable true-wins, lists and raw Nix values LWW), projectRootFile LWW, `let` prelude and `in` tail retained |
| `nix/packages.nix`   | `mergePackages`  | Sub-block merge: function args (union), inherit IDs (LWW per identifier), assignments (LWW)                                                              |
| `nix/shells.nix`     | `mergeShells`    | Shell merge: buildInputs and inherited identifiers (union, dedupe, sort) per shell name; equal function args and `with` preludes required                |
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

## Loss refusal

Function heads are parsed structurally, in one shared place (`cyan/src/loss-guard.ts`), so the single-line form `{ pkgs, env }:` and the multi-line form a formatter produces are the same head:

```nix
{
  atomi,
  pkgs-2605,
  pkgs-unstable,
}:
```

Every merger in the dispatch table is wrapped in the same invariant. If a **function argument**, a **`with` prelude**, an **inherited identifier**, or a **binding** present in any input is absent from the merged output, the merge throws and the message names each thing that went missing:

```text
Cannot merge nix/shells.nix: the merge lost function argument 'env', inherited identifier
'shellHook', prelude 'with env;'. Every function argument, 'with' prelude, inherited
identifier and binding present in an input must survive into the merged output; refusing
rather than emitting a file that is missing them.
```

The guard wraps the dispatch table rather than each merger body, so a merger added later cannot forget it.

Two consequences worth stating plainly:

- **An unmodelled shape refuses; it never degrades to a skeleton.** A file whose body a merger cannot represent — no `all = rec { ... }` block in `packages.nix`, an unknown field inside a `mkShell`, a scoped `inherit (src) ...;` — produces a named error, not a smaller file and exit code 0.
- **The invariant is about names, not right-hand sides.** Last-write-wins on a value (`dotnet = dotnet-sdk;` superseded by `dotnet = dotnet-sdk_9;`) is the documented conflict rule and is unaffected; the binding `dotnet` still has to survive.

Self-merge is a **fixed point** for every dispatch-table file: merging a file alone, or with a copy of itself, returns the same bytes, and merging that result again changes nothing. `test/idempotence.test.ts` walks `inputs/` and asserts this for every fixture it finds, so a fixture added later is covered without being wired up.

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

`inputs/real_diene_shared/` holds a real workspace's six resolver-managed files
verbatim, with provenance. Hand-written fixtures all agreed with the parsers'
assumption that a function head fits on one line, which is why nothing in the
suite saw the multi-line head until a real cascade hit it; that fixture exists so
the suite keeps seeing it.

The `resolver-smoke` gate in `AtomiCloud/nix-registry` is the external check: it
runs the published resolver over a repository's own files with a structure-aware
synthetic child, and asserts nothing is lost, the sentinel survives, and the
output is non-degenerate.

## Integration

Reference this resolver in a template's `cyan.yaml`:

```yaml
resolvers:
  - ref: atomi/nix@3
    config: {}
    files: ['**/*.nix']
```
