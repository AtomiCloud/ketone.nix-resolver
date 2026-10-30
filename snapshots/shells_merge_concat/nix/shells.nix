{
  pkgs,
  packages,
  env,
  shellHook,
}:
with env;
{
  ci = pkgs.mkShell {
    buildInputs = system ++ main ++ lint ++ infra;
    inherit shellHook;
  };

  default = pkgs.mkShell {
    buildInputs = system ++ main ++ dev ++ lint ++ infra;
    inherit shellHook;
  };

  releaser = pkgs.mkShell {
    buildInputs = system ++ main ++ lint ++ infra ++ releaser;
    inherit shellHook;
  };
}
