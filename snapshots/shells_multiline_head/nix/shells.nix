{ env, packages, pkgs, shellHook }:
with env;
{
  cd = pkgs.mkShell {
    buildInputs = main ++ system;
    inherit shellHook;
  };

  default = pkgs.mkShell {
    buildInputs = dev ++ lint ++ main ++ system;
    inherit shellHook;
  };
}
