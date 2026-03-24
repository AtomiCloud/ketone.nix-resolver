{ pkgs, packages, env, shellHook }:
with env;
{
  default = pkgs.mkShell {
    buildInputs = system ++ main ++ dev ++ lint ++ infra;
    inherit shellHook;
  };
}
