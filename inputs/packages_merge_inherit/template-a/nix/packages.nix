{ pkgs, pkgs-2505, atomi }:
let
  all = rec {
    atomipkgs = (
      with atomi;
      rec {
        inherit
          infrautils
          atomiutils
          pls;
      }
    );

    nix-2505 = (
      with pkgs-2505;
      {
        dotnet = dotnet-sdk;
        inherit
          bun
          git;
      }
    );
  };
in
with all;
nix-2505 //
atomipkgs
