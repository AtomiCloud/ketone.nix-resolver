{ pkgs, custom-tool, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      prettier.enable = true;
    };

  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
