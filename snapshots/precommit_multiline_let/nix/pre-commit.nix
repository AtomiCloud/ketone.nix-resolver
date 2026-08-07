{ formatter, packages, pre-commit-lib }:
let
  validator-runtime = "higher-validator";
in
pre-commit-lib.run {
  src = ./.;

  hooks = {
    higher-only.enable = true;

    lower-only = {
      enable = true;
      entry = "${validator-runtime}/bin/lower";
      language = "system";
    };

    shared = {
      enable = true;
      entry = "${validator-runtime}/bin/high";
      language = "system";
    };
  };
}
