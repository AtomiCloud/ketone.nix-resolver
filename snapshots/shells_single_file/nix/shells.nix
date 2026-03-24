{ env, packages, pkgs, shellHook }:
with env;
{
  default = pkgs.mkShell {
    buildInputs = dev ++ main ++ system;
    inherit shellHook;
  };
}
