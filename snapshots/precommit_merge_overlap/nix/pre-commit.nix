{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;

  hooks = {
    treefmt = {
      enable = true;
      excludes = [
        ".*(Changelog|README).+(MD|md)"
        "infra/.*chart.*/.*(MD|md)"
        "infra/.*chart.*/templates/.*(yaml|yml)"
      ];
      package = formatter;
    };
  };
}
