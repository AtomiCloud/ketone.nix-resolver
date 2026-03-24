{ formatter, packages, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;

  hooks = {
    shellcheck = {
      enable = true;
      description = "Shell script linter";
      entry = "shellcheck";
      language = system;
      name = "Shellcheck";
      pass_filenames = true;
    };
  };
}
