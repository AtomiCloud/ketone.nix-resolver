{
  description = "platform-service-b";

  inputs = {
    # util
    flake-utils.url = "github:numtide/flake-utils";

    # registry
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    # registry
    atomipkgs.url = "github:AtomiCloud/nix-registry/v2";
    nixpkgs-2511.url = "github:NixOS/nixpkgs/nixos-25.11";

    # util
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";
    treefmt-nix.url = "github:numtide/treefmt-nix";
  };
  outputs =
    { self

      # utils
    , flake-utils

      # registries
    , nixpkgs-unstable

      # registries
    , atomipkgs
    , nixpkgs-2511

      # utils
    , pre-commit-hooks
    , treefmt-nix
    } @inputs:
    (flake-utils.lib.eachDefaultSystem
      (
        system:
        let
          pkgs-unstable = nixpkgs-unstable.legacyPackages.${system};
          atomi = atomipkgs.packages.${system};
          pkgs-2511 = nixpkgs-2511.legacyPackages.${system};
          pkgs = pkgs-2511;
        in
        with rec {
          packages = import ./nix/packages.nix
            {
              inherit pkgs-unstable atomi pkgs pkgs-2511;
            };
          env = import ./nix/env.nix {
            inherit pkgs packages;
          };
          devShells = import ./nix/shells.nix {
            inherit pkgs env packages;
            shellHook = checks.pre-commit-check.shellHook;
          };
          pre-commit = import ./nix/pre-commit.nix {
            inherit packages pre-commit-lib formatter;
          };
          formatter = import ./nix/fmt.nix {
            inherit treefmt-nix pkgs;
          };
          checks = {
            pre-commit-check = pre-commit;
            format = formatter;
          };
        };
        {
          inherit packages devShells checks formatter;
        }
      )
    )
  ;

}
