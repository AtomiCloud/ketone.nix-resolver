{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;

  hooks = {
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

    a-infisical = {
      enable = true;
      name = "Secrets Scanning";
      description = "Scan for possible secrets";
      entry = "${packages.infisical}/bin/infisical scan . --verbose";
      language = "system";
      pass_filenames = false;
    };
  };
}
