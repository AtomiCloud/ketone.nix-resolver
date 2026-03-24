{ pkgs, packages, env, shellHook }:
with env;
{
  default = pkgs.mkShell {
    buildInputs = system ++ main ++ dev;
    inherit shellHook;
  };
}
