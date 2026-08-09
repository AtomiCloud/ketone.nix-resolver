{ atomi, pkgs-2605, pkgs-unstable }:
let
  all = rec {
    atomipkgs = (
      with atomi;
      {
        inherit
          atomiutils
          cyanprint
          dlint
          infralint
          infrautils
          releaser
          skills-sync
        ;
      }
    );

    nix-2605 = (
      with pkgs-2605;
      {
        inherit
          actionlint
          git
          go-task
          infisical
          nix
          pre-commit
          shellcheck
          treefmt
        ;
      }
    );

    nix-unstable = (
      with pkgs-unstable;
      {
      }
    );
  };
in
with all;
atomipkgs //
nix-2605 //
nix-unstable
