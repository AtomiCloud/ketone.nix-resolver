{ pkgs, treefmt-nix, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      shfmt = {
        enable = true;
        extra_args = [ "--case-indent" ];
      };
      prettier.enable = true;
    };

  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
