{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;

  hooks = {
    a-infisical = {
      enable = true;
      name = "Secrets Scanning";
      description = "Scan for possible secrets";
      entry = "${packages.infisical}/bin/infisical scan . --verbose";
      language = "system";
      pass_filenames = false;
    };

    treefmt = {
      enable = true;
      package = formatter;
      excludes = [
        ".*(Changelog|README).+(MD|md)"
      ];
    };
  };
}
