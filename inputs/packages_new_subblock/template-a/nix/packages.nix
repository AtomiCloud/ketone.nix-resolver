{ pkgs, pkgs-2505, atomi }:
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

    nix-2505 = (
      with pkgs-2505;
      {
        dotnet = dotnet-sdk;
        inherit
          bun;
      }
    );
  };
in
with all;
nix-2505 //
atomipkgs
