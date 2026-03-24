{ treefmt-nix, pkgs, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      shfmt = {
        enable = true;
        extra_args = [ "--indent-switch" ];
      };
      nixpkgs-fmt.enable = true;
    };

  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
