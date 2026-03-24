{ pkgs, treefmt-nix, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      shfmt = {
        enable = true;
        extra_args = [ "--indent-switch" ];
      };
      actionlint.enable = true;
    };

  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
