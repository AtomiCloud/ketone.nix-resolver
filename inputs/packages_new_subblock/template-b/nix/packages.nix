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
        inherit
          git;
      }
    );

    nix-2511 = (
      with pkgs;
      {
        inherit
          nodejs;
      }
    );
  };
in
with all;
nix-2511 //
nix-2505 //
atomipkgs
