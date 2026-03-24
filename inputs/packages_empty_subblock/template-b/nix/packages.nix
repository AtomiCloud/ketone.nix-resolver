{ pkgs, pkgs-2505, atomi }:
let
  all = rec {
    atomipkgs = (
      with atomi;
      rec {
        inherit
          sg;
      }
    );

    nix-2505 = (
      with pkgs-2505;
      {
      }
    );
  };
in
with all;
nix-2505 //
atomipkgs
