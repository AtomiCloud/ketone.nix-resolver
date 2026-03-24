{ atomi, pkgs, pkgs-2505 }:
let
  all = rec {
    atomipkgs = (
      with atomi;
      rec {
        inherit
          infrautils
          pls
          sg
        ;
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
atomipkgs //
nix-2505
