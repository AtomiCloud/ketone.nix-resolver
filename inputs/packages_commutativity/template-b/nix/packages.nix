{ pkgs-2505, atomi }:
let
  all = rec {
    nix-2505 = (
      with pkgs-2505;
      {
        dotnet = dotnet-sdk;
      }
    );
  };
in
with all;
nix-2505
