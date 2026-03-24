{ treefmt-nix, pkgs, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      prettier.enable = false;
      nixpkgs-fmt.enable = true;
    };

  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
