{ treefmt-nix, pkgs, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      shfmt.enable = true;
      actionlint.enable = true;
    };

  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
