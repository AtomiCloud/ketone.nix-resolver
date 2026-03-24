{ pkgs, treefmt-nix, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      prettier.enable = true;
      actionlint.enable = false;
    };

  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
