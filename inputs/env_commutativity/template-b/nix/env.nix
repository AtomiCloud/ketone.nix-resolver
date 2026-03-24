{ pkgs, packages }:
with packages;
{
  main = [
    bun
    dotnet
    k6
  ];

  lint = [
    gitlint
    infralint
  ];

  releaser = [
    sg
  ];
}
