{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;

  hooks = {
    treefmt = {
      enable = true;
      package = formatter;
      excludes = [
        "infra/.*chart.*/templates/.*(yaml|yml)"
        "infra/.*chart.*/.*(MD|md)"
      ];
    };
  };
}
