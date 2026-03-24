{ atomi, pkgs, pkgs-2505 }:
let
  all = rec {
    atomipkgs = (
      with atomi;
      rec {
        dotnetlint = atomi.dotnetlint.override { dotnetPackage = nix-2505.dotnet; };

        helmlint = atomi.helmlint.override { helmPackage = infrautils; };

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
          gitlint
          infisical
          k6
          shellcheck

          # linter
          treefmt
        ;
      }
    );
  };
in
with all;
atomipkgs //
nix-2505
