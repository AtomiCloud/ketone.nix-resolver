{ pkgs, treefmt-nix, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      actionlint = {
        enable = false;
      };
      nixpkgs-fmt.enable = true;
      prettier.enable = true;
    };

  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
