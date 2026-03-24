{ pkgs, packages }:
with packages;
{
  dev = [
    pls
  ];

  releaser = [
    sg
  ];
}
