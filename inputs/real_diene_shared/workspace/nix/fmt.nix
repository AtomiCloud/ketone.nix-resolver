{ treefmt-nix, pkgs, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      actionlint.enable = true;
      nixfmt.enable = true;
      prettier = {
        enable = true;
        excludes = [
          ".claude/skills/vendor/**"
          "Changelog.md"
          "docs/developer/CommitConventions.md"
          "infra/root_chart/**"
        ];
      };
      shfmt.enable = true;
    };
  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
