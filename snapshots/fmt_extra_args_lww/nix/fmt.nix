{ pkgs, treefmt-nix, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      nixpkgs-fmt.enable = true;
      prettier.enable = true;
      shfmt = {
        enable = true;
        extra_args = [ "--case-indent" ];
      };
    };

  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
