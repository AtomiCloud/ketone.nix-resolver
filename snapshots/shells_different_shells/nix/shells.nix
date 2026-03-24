{ env, packages, pkgs, shellHook }:
with env;
{
  ci = pkgs.mkShell {
    buildInputs = lint ++ main ++ system;
    inherit shellHook;
  };

  default = pkgs.mkShell {
    buildInputs = main ++ system;
    inherit shellHook;
  };
}
