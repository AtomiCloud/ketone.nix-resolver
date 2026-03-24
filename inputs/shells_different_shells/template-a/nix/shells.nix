{ pkgs, packages, env, shellHook }:
with env;
{
  default = pkgs.mkShell {
    buildInputs = system ++ main;
    inherit shellHook;
  };
}
