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
        dotnet = dotnet-sdk;

        inherit
          bun
          git
        ;
      }
    );

    nix-2511 = (
      with pkgs;
      {
        inherit
          nodejs
        ;
      }
    );
  };
in
with all;
atomipkgs //
nix-2505 //
nix-2511
