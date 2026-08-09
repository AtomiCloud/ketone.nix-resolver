{ atomi, pkgs-2605, pkgs-unstable }:
let
  all = rec {
    atomipkgs = (
      with atomi;
      {
        inherit
          atomiutils
          releaser
        ;
      }
    );

    nix-2605 = (
      with pkgs-2605;
      {
        inherit
          git
          nix
        ;
      }
    );

    nix-unstable = (
      with pkgs-unstable;
      {
      }
    );
  };
in
with all;
atomipkgs //
nix-2605 //
nix-unstable
