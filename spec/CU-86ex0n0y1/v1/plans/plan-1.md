# Plan 1: Entry Point + flake.nix

## Goal

Implement the resolver entry point (`index.ts`) with dispatch logic and the flake.nix parser/merger.

## Files to Modify/Create

- `index.ts` — Rewrite with dispatch logic and commutativity sort
- `cyan/src/merge-flake.ts` — flake.nix parser and merger

## Approach

### Step 1: Entry Point (`index.ts`)

Replace the current passthrough with a dispatcher:

1. Validate input (non-empty files, matching paths)
2. Sort files by `(layer ASC, template ASC)` for commutativity
3. Extract basename from path — dispatch to correct merge function
4. For `flake.nix` → `merge-flake.ts`
5. For `nix/env.nix` → stub (throw "not yet implemented")
6. Same stub for fmt, packages, shells, pre-commit
7. Return merged result

### Step 2: flake.nix Parser (`merge-flake.ts`)

**Input structure (per file):**
```nix
{
  description = "var__platform__ var__service__";

  inputs = {
    # util
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";

    # registry
    nixpkgs-2511.url = "github:NixOS/nixpkgs/nixos-25.11";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
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
    , nixpkgs-2511
    , nixpkgs-unstable

    } @inputs:
    (flake-utils.lib.eachDefaultSystem
      (
        system:
        let
          pkgs-2511 = nixpkgs-2511.legacyPackages.${system};
          pkgs-unstable = nixpkgs-unstable.legacyPackages.${system};
          atomi = atomipkgs.packages.${system};
          pre-commit-lib = pre-commit-hooks.lib.${system};
        in
        let pkgs = pkgs-2511; in
        with rec {
          pre-commit = import ./nix/pre-commit.nix {
            inherit packages pre-commit-lib formatter;
          };
          formatter = import ./nix/fmt.nix {
            inherit treefmt-nix pkgs;
          };
          packages = import ./nix/packages.nix
            {
              inherit pkgs atomi pkgs-2511 pkgs-unstable;
            };
          env = import ./nix/env.nix {
            inherit pkgs packages;
          };
          devShells = import ./nix/shells.nix {
            inherit pkgs env packages;
            shellHook = checks.pre-commit-check.shellHook;
          };
          checks = {
            pre-commit-check = pre-commit;
            format = formatter;
          };
        };
        {
          inherit checks formatter packages devShells;
        }
      )
    )
  ;

}
```

**Parse strategy:**

1. **Description**: Extract `description = "...";` line value
2. **Inputs block**: Extract everything between `inputs = {` and its closing `};`
   - Parse each `name.url = "...";` entry
   - Track comment groups (`# util`, `# registry`)
3. **Output params**: Extract the `{ self, flake-utils, ... } @inputs:` block
   - Parse param names (strip leading `,` and whitespace)
   - Track comment groups
4. **Registry setup**: Extract `let` block lines like `pkgs-2511 = nixpkgs-2511.legacyPackages.${system};`
5. **`let pkgs = ...; in` aliasing**: Detect and extract
6. **`with rec { ... };` block**: Extract the entire block as-is (LWW)
7. **Final output block**: Extract `{ inherit checks formatter packages devShells; }` as-is (LWW)

**Merge strategy (two modes):**

**Merge (concat + dedupe by name):**

| Section | Merge behavior |
|---------|---------------|
| `inputs` entries | Concat by input name, dedupe. If same name with different URL → LWW (highest layer wins) |
| Output params `{ self, ... }` | Concat param names, dedupe, preserve comment groups, sort alphabetically within groups |
| Registry setup lines (`pkgs-* = ...`) | Concat by LHS name, dedupe. If same name with different expression → LWW |
| `inherit` parts inside import calls | Concat identifiers, dedupe, sort alphabetically |

**LWW (highest layer wins):**

| Section | Behavior |
|---------|----------|
| `description` | Highest layer's value |
| `let pkgs = pkgs-2511; in` | Highest layer's aliasing line |
| `with rec { ... };` block | Highest layer's entire block **except** the `packages` segment |
| `packages` segment's `inherit` | Concat + dedupe identifiers, sort |
| Final output `{ inherit ...; }` | Highest layer's block |
| Everything else | Highest layer wins |

**Pretty-print output:**
```nix
{
  description = "var__platform__ var__service__";

  inputs = {
    # registry
    atomipkgs.url = "github:AtomiCloud/nix-registry/v2";
    nixpkgs-2511.url = "github:NixOS/nixpkgs/nixos-25.11";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    # util
    flake-utils.url = "github:numtide/flake-utils";
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";
    treefmt-nix.url = "github:numtide/treefmt-nix";

  };
  outputs =
    { self

      # registries
    , atomipkgs
    , nixpkgs-2511
    , nixpkgs-unstable

      # utils
    , flake-utils
    , pre-commit-hooks
    , treefmt-nix

    } @inputs:
    (flake-utils.lib.eachDefaultSystem
      (
        system:
        let
          atomi = atomipkgs.packages.${system};
          pkgs-2511 = nixpkgs-2511.legacyPackages.${system};
          pkgs-unstable = nixpkgs-unstable.legacyPackages.${system};
          pre-commit-lib = pre-commit-hooks.lib.${system};
        in
        let pkgs = pkgs-2511; in
        with rec {
          pre-commit = import ./nix/pre-commit.nix {
            inherit packages pre-commit-lib formatter;
          };
          formatter = import ./nix/fmt.nix {
            inherit treefmt-nix pkgs;
          };
          packages = import ./nix/packages.nix
            {
              inherit atomi pkgs pkgs-2511 pkgs-unstable;
            };
          env = import ./nix/env.nix {
            inherit pkgs packages;
          };
          devShells = import ./nix/shells.nix {
            inherit pkgs env packages;
            shellHook = checks.pre-commit-check.shellHook;
          };
          checks = {
            pre-commit-check = pre-commit;
            format = formatter;
          };
        };
        {
          inherit checks formatter packages devShells;
        }
      )
    )
  ;

}
```
- Input entries sorted alphabetically within comment groups
- Output params sorted alphabetically within comment groups
- Registry setup lines sorted alphabetically
- `inherit` identifiers sorted alphabetically
- `with rec { ... };` block taken verbatim from highest layer
- Blank line between `description` and `inputs`
- Blank line after `inputs` block closing `;`
- Trailing newline

## Testing Strategy

- Single file passthrough
- Two files with different registries → inputs merged, registries merged, inherit merged
- Two files with same registry name but different URLs → LWW
- `let pkgs = ...` present in one, absent in other → LWW
- Commutativity (swap input order → identical output)

## Implementation Checklist

- [ ] Rewrite `index.ts` with dispatch logic + stubs for other parsers
- [ ] Implement `cyan/src/merge-flake.ts` with parse + merge + pretty-print
- [ ] Add test cases for flake.nix
- [ ] Verify commutativity for flake.nix
- [ ] Run `cyanprint test resolver .` — flake.nix tests pass
