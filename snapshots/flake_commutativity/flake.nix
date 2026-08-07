{
  description = "platform-service-b";

  inputs = {
    # util
    flake-utils.url = "github:numtide/flake-utils";

    # registry
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    # registry
    nixpkgs-2511.url = "github:NixOS/nixpkgs/nixos-25.11";
  };
  outputs =
    { self

      # utils
    , flake-utils

      # registries
    , nixpkgs-unstable

      # registries
    , nixpkgs-2511
    } @inputs:
    (flake-utils.lib.eachDefaultSystem
      (
        system:
        let
          pkgs-unstable = nixpkgs-unstable.legacyPackages.${system};
          pkgs-2511 = nixpkgs-2511.legacyPackages.${system};
          pkgs = pkgs-2511;
        in
        with rec {
          packages = import ./nix/packages.nix
            {
              inherit pkgs-unstable pkgs pkgs-2511;
            };
        };
        {
          inherit packages;
        }
      )
    )
  ;

}
