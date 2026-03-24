{ pkgs, pkgs-2505, atomi }:
let
  all = rec {
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
nix-2511
