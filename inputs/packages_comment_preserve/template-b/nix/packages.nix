{ atomi, pkgs-2505 }:
let
  all = rec {
    nix-2505 = (
      with pkgs-2505;
      {
        inherit
          k6
          shellcheck;
      }
    );
  };
in
with all;
nix-2505
