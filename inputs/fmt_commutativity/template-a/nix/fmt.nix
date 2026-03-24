{ treefmt-nix, pkgs, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      nixpkgs-fmt.enable = true;
      prettier.enable = true;
      actionlint.enable = false;
    };

  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
