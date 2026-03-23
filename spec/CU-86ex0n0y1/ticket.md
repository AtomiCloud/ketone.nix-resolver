# Ticket: CU-86ex0n0y1

- **Type**: Task
- **Status**: in progress
- **URL**: https://app.clickup.com/t/86ex0n0y1
- **Parent**: CU-86ex0n83c

## Description

Overview

Repo: ketone.nix-resolver
Artifact: atomi/nix
Language: TypeScript
Purpose: Merge multiple nix module files when different CyanPrint templates contribute the same nix file path.

Approach

Convention-based string parsing. Each nix file type has a defined structure that the parser expects. Templates must follow these conventions. The resolver validates input and throws descriptive errors on malformed content.

Commutativity

All merge logic must be commutative — sort inputs by (layer ASC, template ASC) before processing, deduplicate outputs.

File Matching

Config in template's cyan.yaml:

resolvers:
  - resolver: atomi/nix:1
    files: ['nix/env.nix', 'nix/fmt.nix', 'nix/packages.nix', 'nix/shells.nix', 'nix/pre-commit.nix']

env.nix Merge

Input Structure

{ pkgs, packages }:
{
  system = [
    atomiutils
  ];
  dev = [
    pls
    git
  ];
  main = [
    bun
    dotnet
  ];
  lint = [
    treefmt
    gitlint
  ];
}

Convention

Function args line: { pkgs, packages }: (or variations like { pkgs, packages, ... }:)
Body is an attrset where each key maps to a list of package identifiers
Package identifiers are one per line, bare names (not quoted)
Categories are predefined but extensible

Merge Strategy

For each category (key in the attrset):

Collect all package names from all versions
Deduplicate (case-sensitive exact match)
Sort alphabetically
Reconstruct the attrset

Edge Cases

If a template adds a new category that others don't have, include it
If the function args differ between versions, fail with error (templates must use compatible args)
Empty lists after dedup: still include the category key

fmt.nix Merge

Input Structure

{ treefmt-nix, pkgs, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";
    programs = {
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

Convention

Function args line followed by let fmt = { ... }; in
The let ... in wrapper is always present and always wraps a single treefmt-nix.lib.evalModule call
Inside fmt, two top-level keys: projectRootFile (string) and programs (attrset)
programs entries can be:
Single-line enable: nixpkgs-fmt.enable = true;
Multi-line object: full attrset with enable, extra_args, etc.
After the let...in block: (treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper

Merge Strategy

Sort inputs by layer/template (commutativity)
For projectRootFile: highest layer wins
For programs: deep merge
Single-line enable = true and multi-line objects both treated as attrsets
After normalizing to attrset form, merge by key
For boolean enable: true wins (if any template enables it, it stays enabled)
For arrays (e.g., extra_args): LWW (highest layer wins)
Reconstruct the let...in wrapper

Edge Cases

A program enabled by one template and explicitly enable = false by another: true wins (any enable = true)
extra_args or similar arrays: concat + dedupe
Unknown top-level keys beyond projectRootFile/programs: fail with error (convention violation)

pre-commit.nix Merge

Input Structure

{ packages, formatter, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;

  hooks = {
    shellcheck.enable = false;

    treefmt = {
      enable = true;
      package = formatter;
      excludes = [
        "infra/.*chart.*/templates/.*(yaml|yml)"
      ];
    };

    a-custom-hook = rec {
      enable = true;
      name = "My Hook";
      entry = "${packages.somepkg}/bin/myhook";
      files = ".*\\.ts$";
      language = "system";
      pass_filenames = false;
      stages = [ "pre-commit" ];
    };
  };
}

Convention

Function args line followed by pre-commit-lib.run { ... };
Top-level keys: src, hooks (and possibly tools)
hooks is an attrset where each key maps to a hook config
Hook configs can use rec for self-referencing
Common hook fields: enable, name, description, entry, package, files, language, pass_filenames, stages, excludes

Merge Strategy

Same pattern as fmt.nix:

Sort inputs by layer/template
For src: highest layer wins
For hooks: deep merge per hook key
enable: true wins
Arrays (excludes, stages): LWW (highest layer wins)
String fields (name, entry, files, language): highest layer wins
Reconstruct wrapper

Edge Cases

Same hook key with conflicting config: deep merge (same rules as above)
Unknown hook fields: passthrough, highest layer wins

shells.nix Merge

Input Structure

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

Convention

Function args: { pkgs, packages, env, shellHook }: (order may vary)
Always starts with with env;
Body is an attrset where each key is a shell name
Each shell uses pkgs.mkShell { ... };
Inside each shell: buildInputs is a concat of env category references (system ++ main ++ dev)
inherit shellHook; is always present
No other fields expected inside shells (fail on unknown keys)

Merge Strategy

Sort inputs by layer/template (commutativity)
For each shell name across all versions:
Concat all buildInputs entries
Deduplicate (category references are just identifiers like system, main)
Sort alphabetically
Reconstruct with with env; wrapper

Edge Cases

One template has default, another doesn't → default is still included
Empty buildInputs after dedup → still include the shell (empty list)
Function args differ → fail with error (convention violation)
inherit shellHook; is assumed, not merged

packages.nix Merge

Input Structure

{ pkgs, pkgs-2505, atomi }:
let
  all = rec {
    atomipkgs = (
      with atomi;
      rec {
        dotnetlint = atomi.dotnetlint.override { dotnetPackage = nix-2505.dotnet; };
        helmlint = atomi.helmlint.override { helmPackage = infrautils; };
        inherit infrautils atomiutils infralint pls sg;
      }
    );
    nix-2505 = (
      with pkgs-2505;
      {
        dotnet = dotnet-sdk;
        inherit bun infisical git k6 treefmt gitlint shellcheck;
      }
    );
  };
in
with all;
nix-2505 // atomipkgs

Convention

Function args: { pkgs, pkgs-2505, atomi }: — set of named registries
Always uses let all = rec { ... }; in pattern
Inside all: named sub-blocks (e.g., atomipkgs, nix-2505) acting as package registries
Each sub-block uses with <registry>; to scope its packages
Entries within a sub-block:
inherit lines: pulls from the registry (e.g., inherit infrautils atomiutils;)
Bare assignments: dotnet = dotnet-sdk;
Override calls: dotnetlint = atomi.dotnetlint.override { ... };
Sub-blocks use rec for self-referencing
Final line: with all; <sub-block1> // <sub-block2> // ... (concat all sub-blocks)

Merge Strategy

Sort inputs by layer/template (commutativity)
Function args: concat all arg identifiers across versions, dedupe, sort
Sub-blocks: for each sub-block name across all versions:
inherit lines: concat all inherit lists, dedupe identifiers, sort
Named assignments (bare + overrides): merge by LHS key name
If key exists in only one template → include it
If same key in multiple templates → LWW (highest layer wins)
Final merge line: concat all sub-block names with //, dedupe, sort

Edge Cases

New sub-block from one template, not in others → include it
Sub-block with only overrides from higher layer (no inherit/bare) → still included
Function args differ → merge + dedupe (not fail), all referenced registries get included
LWW override references a package that only a lower layer defined → risk accepted, not validated
Empty sub-block after merge → still included

Testing Plan

Single file resolution (1 input → passthrough)
env.nix: two files, disjoint categories → all categories present
env.nix: two files, overlapping packages → deduplicated
fmt.nix: single-line vs multi-line program forms
fmt.nix: conflicting enable flags
fmt.nix: extra_args LWW
pre-commit.nix: multiple hooks from different templates
pre-commit.nix: same hook key conflicting config
pre-commit.nix: excludes LWW
shells.nix: same shell from multiple templates → buildInputs concat + dedupe
shells.nix: different shells from different templates → all included
packages.nix: same sub-block, inherit lines merged
packages.nix: same sub-block, LWW for override assignment
packages.nix: new sub-block from one template
packages.nix: function args concat + dedupe
packages.nix: final merge line concat + dedupe
Commutativity: same inputs in different order → identical output (all file types)
Error cases: malformed input, missing convention structure
Integration: real nix files from zinc as test fixtures

---

# Parent: CU-86ex0n83c (Task)

- **Title**: Nix Template (atomi/nix)
- **Status**: todo
- **URL**: https://app.clickup.com/t/86ex0n83c

## Description

Overview

Repo: ketone.nix
Artifact: atomi/nix
Purpose: Rewrite the existing atomi/nix-init template to use the new cyan/new meta-template system with composable additive folders that merge via nix resolvers.

Current State

atomi/nix-init uses a branching mode system in cyan/index.ts:

Standard: description, standard-binary checkbox, pre-commit checkbox
CyanPrint Bun: separate mode for Bun-based projects (to be removed, moved to atomi/cyan)
AtomiCloud Suite: runtime select (Go/.NET/Bun), platform/service text inputs, infra confirm

Problems with the current approach:

Monolithic index.ts with complex branching logic
Mode selection baked into the template entry point
Hard to extend with new runtimes without modifying core logic
No resolver-based file merging — all files come from a single template pass

New Architecture

Replace branching modes with composable additive folders. Each folder is an independent template contribution that gets merged via the nix resolver (atomi/nix).
