{
  description = "platform-service";

  inputs = {
    # util
    flake-utils.url = "github:numtide/flake-utils";

    # registry
    nixpkgs-2511.url = "github:NixOS/nixpkgs/nixos-25.11";
    atomipkgs.url = "github:AtomiCloud/nix-registry/v2";

  };
  outputs =
    { self

      # utils
    , flake-utils

      # registries
    , atomipkgs
    , nixpkgs-2511

    } @inputs:
    (flake-utils.lib.eachDefaultSystem
      (
        system:
        let
          pkgs-2511 = nixpkgs-2511.legacyPackages.${system};
          atomi = atomipkgs.packages.${system};
        in
        let pkgs = pkgs-2511; in
        with rec {
          packages = import ./nix/packages.nix
            {
              inherit pkgs atomi pkgs-2511;
            };
        };
        {
          inherit packages;
        }
      )
    )
  ;

}
