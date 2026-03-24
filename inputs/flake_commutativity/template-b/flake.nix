{
  description = "platform-service-b";

  inputs = {
    # util
    flake-utils.url = "github:numtide/flake-utils";

    # registry
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

  };
  outputs =
    { self

      # utils
    , flake-utils

      # registries
    , nixpkgs-unstable

    } @inputs:
    (flake-utils.lib.eachDefaultSystem
      (
        system:
        let
          pkgs-unstable = nixpkgs-unstable.legacyPackages.${system};
        in
        with rec {
          packages = import ./nix/packages.nix
            {
              inherit pkgs-unstable;
            };
        };
        {
          inherit packages;
        }
      )
    )
  ;

}
