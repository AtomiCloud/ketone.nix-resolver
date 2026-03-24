{ env, packages, pkgs, shellHook }:
with env;
{
  default = pkgs.mkShell {
    buildInputs = dev ++ infra ++ lint ++ main ++ system;
    inherit shellHook;
  };
}
