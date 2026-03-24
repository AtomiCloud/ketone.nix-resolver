{
  description = "platform-service-b";

  inputs = {
    # util
    flake-utils.url = "github:numtide/flake-utils";

    # registry
    nixpkgs-2511.url = "github:NixOS/nixpkgs/nixos-25.11";

  };
  outputs =
    { self

      # utils
    , flake-utils

      # registries
    , nixpkgs-2511

    } @inputs:
    (flake-utils.lib.eachDefaultSystem
      (
        system:
        let
          pkgs-2511 = nixpkgs-2511.legacyPackages.${system};
        in
        with rec {
          packages = import ./nix/packages.nix
            {
              inherit pkgs-2511;
            };
        };
        {
          inherit packages;
        }
      )
    )
  ;

}
