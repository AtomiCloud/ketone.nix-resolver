{ pkgs, packages }:
with packages;
{
  dev = [
    git
    pls
  ];

  main = [
    bun
  ];

  releaser = [
    sg
  ];
}
