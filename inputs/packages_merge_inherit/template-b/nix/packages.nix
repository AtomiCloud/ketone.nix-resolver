{ pkgs, pkgs-2505, atomi }:
let
  all = rec {
    atomipkgs = (
      with atomi;
      rec {
        inherit
          infralint
          sg;
      }
    );

    nix-2505 = (
      with pkgs-2505;
      {
        inherit
          k6
          treefmt;
      }
    );
  };
in
with all;
nix-2505 //
atomipkgs
