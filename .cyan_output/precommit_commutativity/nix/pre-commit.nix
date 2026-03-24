{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;

  hooks = {
    a-helm-lint = {
      enable = true;
      description = "Lints helm charts";
      entry = "${package}/bin/helmlint";
      files = "infra/.*";
      language = system;
      name = "Lint Helm Charts";
      package = packages.infralint;
      pass_filenames = false;
    };

    a-infisical = {
      enable = true;
      description = "Scan for possible secrets";
      entry = "${packages.infisical}/bin/infisical scan . --verbose";
      language = system;
      name = "Secrets Scanning";
      pass_filenames = false;
    };

    shellcheck.enable = false;

    treefmt = {
      enable = true;
      excludes = [
        ".*(Changelog|README).+(MD|md)"
        "infra/.*chart.*/templates/.*(yaml|yml)"
      ];
      package = formatter;
    };
  };
}
