{
  description = "platform-service-b";

  inputs = {
    # registry
    nixpkgs-2511.url = "github:NixOS/nixpkgs/nixos-25.11";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    # util
    flake-utils.url = "github:numtide/flake-utils";

  };
  outputs =
    { self

      # registries
    , nixpkgs-2511
    , nixpkgs-unstable

      # utils
    , flake-utils

    } @inputs:
    (flake-utils.lib.eachDefaultSystem
      (
        system:
        let
          pkgs-2511 = nixpkgs-2511.legacyPackages.${system};
          pkgs-unstable = nixpkgs-unstable.legacyPackages.${system};
        in
        
        with rec {
          packages = import ./nix/packages.nix
            {
              inherit pkgs pkgs-2511 pkgs-unstable;
            };
        };
        {
          inherit packages;
        }
      )
    )
  ;

}
