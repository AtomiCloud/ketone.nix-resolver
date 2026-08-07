{
  formatter,
  packages,
  pre-commit-lib,
}:
let
  validator-runtime = "lower-validator";
in
pre-commit-lib.run {
  src = ./.;

  hooks = {
    lower-only = {
      enable = true;
      entry = "${validator-runtime}/bin/lower";
      language = "system";
    };

    shared = {
      enable = true;
      entry = "${validator-runtime}/bin/low";
      language = "system";
    };
  };
}
