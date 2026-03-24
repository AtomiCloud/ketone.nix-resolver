{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;

  hooks = {
    treefmt = {
      enable = true;
      package = formatter;
      excludes = [
        "infra/.*chart.*/.*(MD|md)"
        ".*(Changelog|README).+(MD|md)"
      ];
    };
  };
}
