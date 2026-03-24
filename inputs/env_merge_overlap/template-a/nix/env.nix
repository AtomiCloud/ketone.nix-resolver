{ pkgs, packages }:
with packages;
{
  dev = [
    pls
    git
    treefmt
  ];

  main = [
    bun
    dotnet
  ];
}
