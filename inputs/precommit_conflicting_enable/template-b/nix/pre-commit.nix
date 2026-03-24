{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;

  hooks = {
    shellcheck = {
      enable = true;
      name = "Shellcheck";
      description = "Shell script linter";
      entry = "shellcheck";
      language = "system";
      pass_filenames = true;
    };
  };
}
