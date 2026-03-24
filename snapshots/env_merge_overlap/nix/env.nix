{ pkgs, packages }:
with packages;
{
  dev = [
    git
    helmlint
    pls
    shellcheck
    treefmt
  ];

  lint = [
    treefmt
  ];

  main = [
    bun
    dotnet
  ];
}
