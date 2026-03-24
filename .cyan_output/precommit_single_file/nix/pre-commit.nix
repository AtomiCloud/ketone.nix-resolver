{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;

  hooks = {
    a-helm-lint = rec {
      enable = true;
      description = "Lints helm charts";
      entry = "${package}/bin/helmlint";
      files = "infra/.*";
      language = system;
      name = "Lint Helm Charts";
      package = packages.infralint;
      pass_filenames = false;
    };

    shellcheck.enable = false;

    treefmt = {
      enable = true;
      excludes = [
        "infra/.*chart.*/templates/.*(yaml|yml)"
      ];
      package = formatter;
    };
  };
}
