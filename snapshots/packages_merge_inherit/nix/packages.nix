{ atomi, pkgs, pkgs-2505 }:
let
  all = rec {
    atomipkgs = (
      with atomi;
      rec {
        inherit
          atomiutils
          infralint
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
          k6
          treefmt
        ;
      }
    );
  };
in
with all;
atomipkgs //
nix-2505
