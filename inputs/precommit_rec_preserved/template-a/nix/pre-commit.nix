{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;

  hooks = {
    a-helm-lint = rec {
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
