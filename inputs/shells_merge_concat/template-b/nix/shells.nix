{ pkgs, packages, env, shellHook }:
with env;
{
  ci = pkgs.mkShell {
    buildInputs = system ++ main ++ lint;
    inherit shellHook;
  };
}
