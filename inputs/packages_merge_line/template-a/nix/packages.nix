{ pkgs, pkgs-2505, atomi }:
let
  all = rec {
    atomipkgs = (
      with atomi;
      rec {
        inherit
          infrautils;
      }
    );

    nix-2505 = (
      with pkgs-2505;
      {
        inherit
          bun;
      }
    );
  };
in
with all;
nix-2505 //
atomipkgs
