{
  # ### workspace-flake
  # #### source: workspace
  inputs = {
    # util
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";

    # registry
    #
    # Every nixpkgs input is pinned to an EXACT COMMIT, never to a channel name.
    # A channel branch moves under us, so a floating ref makes the same tree
    # build differently on two days. Moving a pin is a deliberate human-cadence
    # action, taken on purpose by a person: drift away from upstream is reported
    # separately, on its own regular cadence, and that report never bumps
    # anything itself.
    #
    # THIS IS ENFORCED. `scripts/validate/nixpkgs-pin.sh` runs as the `a-nixpkgs-pin`
    # hook whenever this file or the lock changes, and refuses a root nixpkgs input
    # that follows a channel, a lock whose resolution disagrees with what it asked
    # for, or a commit named here that is not the one in force. The gate this comment
    # used to mourn was deleted by owner ruling on 2026-08-05; the practice outlived
    # it and now has an enforcer again. A floating ref reintroduced here turns the
    # commit red, which was demonstrated before the guard landed.
    #
    # nixos-unstable @ 2026-08-05
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/e72e4f299401a3689d4b3d5fc6496b11db7064eb";
    # nixos-26.05 (Yarara) @ 2026-07-17
    nixpkgs-2605.url = "github:NixOS/nixpkgs/4382ed2b7a6839d4280a9b386db49cbc5907414d";
    # NOTHING VALIDATES THIS. `v4` is retargeted at every registry release, so this
    # input moves within the v4 major line whenever the lock is refreshed, and
    # `flake.lock` alone records which commit is in force. Downstream templates
    # inherit this line rather than re-pinning it, so an exact tag here would pin
    # every child too. Unlike the nixpkgs inputs above, a moving ref is the intent.
    atomipkgs.url = "github:AtomiCloud/nix-registry/v4";
  };
  outputs =
    {
      self,

      # utils
      flake-utils,
      treefmt-nix,
      pre-commit-hooks,

      # registries
      atomipkgs,
      nixpkgs-2605,
      nixpkgs-unstable,

    }@inputs:
    (flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs-2605 = nixpkgs-2605.legacyPackages.${system};
        pkgs-unstable = nixpkgs-unstable.legacyPackages.${system};
        atomi = atomipkgs.packages.${system};
        pre-commit-lib = pre-commit-hooks.lib.${system};
      in
      let
        pkgs = pkgs-2605;
      in
      with rec {
        pre-commit = import ./nix/pre-commit.nix {
          inherit
            packages
            pkgs
            pre-commit-lib
            formatter
            ;
        };
        formatter = import ./nix/fmt.nix {
          inherit treefmt-nix pkgs;
        };
        packages = import ./nix/packages.nix {
          inherit
            pkgs-2605
            pkgs-unstable
            atomi
            ;
        };
        env = import ./nix/env.nix {
          inherit pkgs packages;
        };
        devShells = import ./nix/shells.nix {
          inherit pkgs env packages;
          shellHook = checks.pre-commit-check.shellHook;
        };
        checks = {
          pre-commit-check = pre-commit;
          format = formatter;
        };
      };
      {
        inherit
          checks
          formatter
          packages
          devShells
          ;
      }
    ));

}
