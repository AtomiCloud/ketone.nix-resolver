{
  description = "platform-service";

  inputs = {
    # registry
    atomipkgs.url = "github:AtomiCloud/nix-registry/v2";
    nixpkgs-2511.url = "github:NixOS/nixpkgs/nixos-25.11";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    # util
    flake-utils.url = "github:numtide/flake-utils";
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";
    treefmt-nix.url = "github:numtide/treefmt-nix";

  };
  outputs =
    { self

      # registries
    , atomipkgs
    , nixpkgs-2511
    , nixpkgs-unstable

      # utils
    , flake-utils
    , pre-commit-hooks
    , treefmt-nix

    } @inputs:
    (flake-utils.lib.eachDefaultSystem
      (
        system:
        let
          atomi = atomipkgs.packages.${system};
          pkgs-2511 = nixpkgs-2511.legacyPackages.${system};
          pkgs-unstable = nixpkgs-unstable.legacyPackages.${system};
          pre-commit-lib = pre-commit-hooks.lib.${system};
          pkgs = pkgs-2511;
        in
        
        with rec {
          pre-commit = import ./nix/pre-commit.nix {
            inherit packages pre-commit-lib formatter;
          formatter = import ./nix/fmt.nix {
            inherit treefmt-nix pkgs;
          packages = import ./nix/packages.nix
            {
              inherit pkgs atomi pkgs-2511 pkgs-unstable;
          env = import ./nix/env.nix {
            inherit pkgs packages;
          devShells = import ./nix/shells.nix {
            inherit pkgs env packages;
            shellHook = checks.pre-commit-check.shellHook;
          checks = { pre-commit-check = pre-commit; format = formatte; };
        };
        {
          inherit checks formatter packages devShells;
        }
      )
    )
  ;

}
