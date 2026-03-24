{ pkgs, packages }:
with packages;
{
  dev = [
    git
    pls
  ];

  main = [
    bun
    dotnet
  ];

  system = [
    atomiutils
  ];
}
