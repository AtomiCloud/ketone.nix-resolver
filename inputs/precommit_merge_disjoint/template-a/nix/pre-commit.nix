{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;

  hooks = {
    shellcheck.enable = false;

    treefmt = {
      enable = true;
      package = formatter;
      excludes = [
        "infra/.*chart.*/templates/.*(yaml|yml)"
      ];
    };
  };
}
