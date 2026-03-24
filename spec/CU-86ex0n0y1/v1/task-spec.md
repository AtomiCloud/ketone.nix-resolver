# Task Spec: Nix Resolver (atomi/nix) — v1

**Ticket:** CU-86ex0n0y1
**Repo:** ketone.nix-resolver
**Language:** TypeScript
**Runtime:** Bun

## Objective

Build a CyanPrint resolver that merges multiple Nix module files when different templates contribute the same file path. The resolver handles 6 specific file types, each with a distinct merge strategy. It uses convention-based string parsing (no Nix AST evaluation).

## Scope

### In Scope
- Merge logic for 6 file types: `flake.nix`, `env.nix`, `fmt.nix`, `packages.nix`, `shells.nix`, `pre-commit.nix`
- Input validation and descriptive error messages
- Commutativity guarantees (identical output regardless of input order)
- Comprehensive test suite covering all merge strategies and edge cases
- Documentation (README)

### Out of Scope
- Actual Nix evaluation or AST parsing
- Template authoring — templates must follow documented conventions
- Nix syntax validation beyond convention checks
- Custom merge strategies via config

## Architecture

### Entry Point
- `index.ts` — dispatches to the correct parser based on file path
- Files are sorted by `(layer ASC, template ASC)` before processing

### Module Organization (under `cyan/src/`)
- `merge-flake.ts` — flake.nix parser and merger
- `merge-env.ts` — env.nix parser and merger
- `merge-fmt.ts` — fmt.nix parser and merger
- `merge-packages.ts` — packages.nix parser and merger
- `merge-shells.ts` — shells.nix parser and merger
- `merge-precommit.ts` — pre-commit.nix parser and merger

### Dispatch Logic

The engine matches files via a glob configured in templates (e.g., `**/*.nix`). The resolver receives all conflicting files at the same path and dispatches based on basename:

```typescript
// "flake.nix"      → merge-flake
// "env.nix"        → merge-env
// "fmt.nix"        → merge-fmt
// "packages.nix"   → merge-packages
// "shells.nix"     → merge-shells
// "pre-commit.nix" → merge-precommit
// anything else    → throw Error (unsupported file type)
```

## Merge Strategies (per file type)

### 0. flake.nix — Structured Partial Merge

**Structure:**
```nix
{
  description = "var__platform__ var__service__";
  inputs = {
    # util
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";

    # registry
    nixpkgs-unstable.url = "nixpkgs/nixos-unstable";
    atomipkgs.url = "github:AtomiCloud/nix-registry/v2";
  };
  outputs =
    { self

      # utils
    , flake-utils
    , treefmt-nix
    , pre-commit-hooks

      # registries
    , atomipkgs
    , nixpkgs-unstable

    } @inputs:
    (flake-utils.lib.eachDefaultSystem
      (system:
      let
        pkgs-unstable = nixpkgs-unstable.legacyPackages.${system};
        atomi = atomipkgs.packages.${system};
        pre-commit-lib = pre-commit-hooks.lib.${system};
      in
      let pkgs = pkgs-2511; in
      with rec {
        packages = import ./nix/packages.nix {
            inherit pkgs pkgs-2511 pkgs-unstable atomi;
        };
        ...
      };
      {
        inherit checks formatter packages devShells;
      })
    );
}
```

**Merge strategy — two distinct modes:**

**Merge (concat + dedupe by name):**
- `inputs` entries — concat all `name.url = "...";` entries, dedupe by input name (LWW if same name with different URL)
- Output params (`{ self, flake-utils, ... }`) — concat all param names, dedupe, sort within comment groups (`# utils`, `# registries`)
- Registry setup lines (`pkgs-* = ...;`) — concat, dedupe by LHS name (LWW if same name with different expression)
- `inherit` parts inside import calls — concat all identifiers, dedupe, sort

**LWW (highest layer wins):**
- `description`
- `let pkgs = pkgs-2511; in` aliasing lines
- The `with rec { ... };` block structure (imports of pre-commit, formatter, packages, env, devShells, checks) — **except** the `packages` segment's `inherit` identifiers
- `packages` segment's `inherit` identifiers: concat + dedupe, sort
- Final output block (`{ inherit checks formatter packages devShells; }`)
- Everything else not explicitly listed as merge

### 1. env.nix — Package Category Merge

**Structure:** `{ args }: { category = [ packages ]; ... }`

- Function args must match exactly across all inputs (fail otherwise)
- Collect package names per category from all inputs
- Deduplicate, sort alphabetically
- Include new categories from any input
- Empty lists preserved

### 2. fmt.nix — Deep Merge Programs

**Structure:** `{ args }: let fmt = { projectRootFile, programs }; in (treefmt-nix.lib.evalModule ...)`

- `projectRootFile`: highest layer wins
- `programs`: deep merge by program key
- `enable` (boolean): `true` wins over `false`
- `extra_args` (array): LWW (highest layer wins)
- Unknown top-level keys beyond `projectRootFile`/`programs`: fail

### 3. pre-commit.nix — Deep Merge Hooks

**Structure:** `{ args }: pre-commit-lib.run { src, hooks, ... }`

- `src`: highest layer wins
- `hooks`: deep merge per hook key
- `enable` (boolean): `true` wins
- Arrays (`excludes`, `stages`): concat + dedupe
- String fields (`name`, `entry`, `files`, `language`): highest layer wins
- Unknown fields: passthrough, highest layer wins

### 4. shells.nix — BuildInputs Concat

**Structure:** `{ args }: with env; { shellName = pkgs.mkShell { buildInputs = ...; inherit shellHook; }; ... }`

- Function args must match exactly (fail otherwise)
- For each shell name: concat buildInputs, dedupe, sort
- `inherit shellHook;` is assumed, not merged
- New shells from any input included
- Unknown fields inside shells: fail

### 5. packages.nix — Registry Merge

**Structure:** `{ args }: let all = rec { block = ...; }; in with all; block1 // block2`

- Function args: concat + dedupe + sort (not fail)
- Sub-blocks merged by name
- `inherit` lines: concat + dedupe + sort within each sub-block
- Named assignments (bare + overrides): LWW by LHS key name
- Final merge line: concat sub-block names, dedupe, sort
- Empty sub-blocks preserved
- LWW override referencing lower-layer package: risk accepted

## Commutativity Requirements

- **All merge logic must be commutative and associative**
- Sort inputs by `(layer ASC, template ASC)` before processing
- Deduplicate outputs
- Deterministic ordering of all collections (categories, packages, keys, etc.)

## Error Handling

- Empty files list: throw Error
- Mismatched paths: throw Error
- Malformed content (missing expected structure): throw Error with descriptive message
- Unknown keys in strict-mode files (fmt.nix, shells.nix): throw Error

## Acceptance Criteria

### Core Functionality
- [ ] Single file input → passthrough (all 6 file types)
- [ ] flake.nix: inputs merge (concat + dedupe by name)
- [ ] flake.nix: output params merge (concat + dedupe)
- [ ] flake.nix: registry setup merge (concat + dedupe)
- [ ] flake.nix: inherit parts merge (concat + dedupe)
- [ ] flake.nix: `let pkgs = ...; in` LWW
- [ ] flake.nix: everything else LWW
- [ ] env.nix: merge categories across multiple inputs, dedupe + sort
- [ ] env.nix: function args mismatch → error
- [ ] fmt.nix: deep merge programs (single-line and multi-line forms)
- [ ] fmt.nix: `enable = true` wins over `enable = false`
- [ ] fmt.nix: extra_args LWW (highest layer wins)
- [ ] pre-commit.nix: deep merge hooks per key
- [ ] pre-commit.nix: arrays concat+dedupe, strings LWW
- [ ] shells.nix: buildInputs concat + dedupe per shell
- [ ] shells.nix: different shells from different inputs → all included
- [ ] packages.nix: sub-blocks merge (inherit concat, assignments LWW)
- [ ] packages.nix: function args concat + dedupe
- [ ] packages.nix: final merge line concat + dedupe

### Quality
- [ ] Commutativity: same inputs in different order → identical output
- [ ] Error cases: malformed input, missing structure → descriptive error
- [ ] All tests pass via `cyanprint test resolver .`
- [ ] README documents merge strategies and conventions
- [ ] Pretty-print: output matches zinc formatting conventions (2-space indent, blank lines between sections, multi-line inherit, trailing newline)

## Pretty-Print Output Format

All resolved output must follow the formatting conventions observed in the real zinc nix files. Reference: `/Users/erng/Workspace/atomi/runbook/platforms/alcohol/zinc/nix/` and `/Users/erng/Workspace/atomi/runbook/platforms/alcohol/zinc/flake.nix`.

### General
- 2-space indentation throughout
- Blank line between major sections (categories in env.nix, programs in fmt.nix, hooks in pre-commit.nix, sub-blocks in packages.nix)
- Trailing newline at end of file

### flake.nix
- 2-space indent
- Inputs grouped by comment headers (`# util`, `# registry`)
- Output params grouped by comment headers, sorted alphabetically within groups
- Registry setup lines sorted alphabetically
- Blank lines between logical sections

### env.nix
- `with packages;` on the line after function args
- Each category key gets its own block, separated by blank lines
- Package names one per line inside brackets

### fmt.nix
- `let fmt = {` on separate lines with 2-space indent
- `projectRootFile` and `programs` separated by blank line
- Single-line programs: `program-name.enable = true;`
- Multi-line programs: full attrset with 2-space indent

### packages.nix
- `inherit` uses multi-line format, one identifier per line, indented
- Blank lines between entries within sub-blocks
- Sub-blocks indented with 2-space indent
- Parenthesized `with` blocks

### pre-commit.nix
- Blank lines between hooks
- `rec` keyword preserved when present in original
- `src = ./.;` on separate line from `hooks`

### shells.nix
- `with env;` on line after function args
- `buildInputs` on one line (wrapped if too long)
- `inherit shellHook;` indented inside mkShell block

## Constraints

- Must use `@atomicloud/cyan-sdk` v2.1.0+
- No external dependencies beyond SDK
- No Nix evaluation — purely string-based parsing
- Templates must follow documented conventions
