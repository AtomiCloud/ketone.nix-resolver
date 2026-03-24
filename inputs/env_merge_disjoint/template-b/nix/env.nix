{ pkgs, packages }:
with packages;
{
  lint = [
    treefmt
    shellcheck
  ];

  main = [
    bun
    dotnet
  ];
}
