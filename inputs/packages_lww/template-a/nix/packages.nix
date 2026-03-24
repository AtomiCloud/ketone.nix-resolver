{ pkgs, pkgs-2505, atomi }:
let
  all = rec {
    atomipkgs = (
      with atomi;
      rec {
        dotnetlint = atomi.dotnetlint.override { dotnetPackage = nix-2505.dotnet; };

        inherit
          infrautils
          pls;
      }
    );

    nix-2505 = (
      with pkgs-2505;
      {
        dotnet = dotnet-sdk;
      }
    );
  };
in
with all;
nix-2505 //
atomipkgs
