{ pkgs, packages }:
with packages;
{
  dev = [
    git
    pls
  ];

  lint = [
    shellcheck
    treefmt
  ];

  main = [
    bun
    dotnet
  ];

  system = [
    atomiutils
  ];
}
