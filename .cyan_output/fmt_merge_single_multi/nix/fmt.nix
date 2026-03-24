{ pkgs, treefmt-nix, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      actionlint.enable = true;
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
