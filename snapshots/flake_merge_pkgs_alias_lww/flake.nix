{
  description = "platform-service-b";

  inputs = {
    # util
    flake-utils.url = "github:numtide/flake-utils";

    # registry
    nixpkgs-2511.url = "github:NixOS/nixpkgs/nixos-25.11";

    # registry
    atomipkgs.url = "github:AtomiCloud/nix-registry/v2";
  };
  outputs =
    { self

      # utils
    , flake-utils

      # registries
    , nixpkgs-2511

      # registries
    , atomipkgs
    } @inputs:
    (flake-utils.lib.eachDefaultSystem
      (
        system:
        let
          pkgs-2511 = nixpkgs-2511.legacyPackages.${system};
          atomi = atomipkgs.packages.${system};
          pkgs = pkgs-2511;
        in
        with rec {
          packages = import ./nix/packages.nix
            {
              inherit pkgs-2511 atomi pkgs;
            };
        };
        {
          inherit packages;
        }
      )
    )
  ;

}
