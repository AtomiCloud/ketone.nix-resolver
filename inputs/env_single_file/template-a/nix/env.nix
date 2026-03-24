{ pkgs, packages }:
with packages;
{
  system = [
    atomiutils
  ];

  dev = [
    pls
    git
  ];

  main = [
    bun
    dotnet
  ];
}
