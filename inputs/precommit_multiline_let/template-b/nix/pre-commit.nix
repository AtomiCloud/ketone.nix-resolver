{
  formatter,
  packages,
  pre-commit-lib,
}:
let
  validator-runtime = "higher-validator";
in
pre-commit-lib.run {
  src = ./.;

  hooks = {
    higher-only.enable = true;

    shared = {
      enable = false;
      entry = "${validator-runtime}/bin/high";
      language = "system";
    };
  };
}
