{ pkgs, packages }:
with packages;
{
  dev = [
    git
  ];

  main = [
    bun
  ];
}
