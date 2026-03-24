{ env, packages, pkgs, shellHook }:
with env;
{
  ci = pkgs.mkShell {
    buildInputs = infra ++ lint ++ main ++ system;
    inherit shellHook;
  };

  default = pkgs.mkShell {
    buildInputs = dev ++ infra ++ lint ++ main ++ system;
    inherit shellHook;
  };

  releaser = pkgs.mkShell {
    buildInputs = infra ++ lint ++ main ++ releaser ++ system;
    inherit shellHook;
  };
}
