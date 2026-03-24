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

    a-helm-lint = {
      enable = true;
      name = "Lint Helm Charts";
      package = packages.infralint;
      description = "Lints helm charts";
      entry = "${package}/bin/helmlint";
      files = "infra/.*";
      language = "system";
      pass_filenames = false;
    };
  };
}
