{ pkgs, packages, env, shellHook }:
with env;
{
  default = pkgs.mkShell {
    buildInputs = main ++ dev;
    inherit shellHook;
  };
}
