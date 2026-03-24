{ pkgs, atomi }:
let
  all = rec {
    atomipkgs = (
      with atomi;
      rec {
        inherit
          infrautils
          pls;
      }
    );
  };
in
with all;
atomipkgs
