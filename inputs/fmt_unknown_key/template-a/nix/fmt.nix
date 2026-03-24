{ pkgs, treefmt-nix, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";
    unknownSetting = "foo";

    programs = {
      nixpkgs-fmt.enable = true;
    };

  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
