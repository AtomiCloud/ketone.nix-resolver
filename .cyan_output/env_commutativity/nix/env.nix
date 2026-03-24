{ pkgs, packages }:
with packages;
{
  dev = [
    git
    pls
  ];

  lint = [
    gitlint
    infralint
    shellcheck
    treefmt
  ];

  main = [
    bun
    dotnet
    k6
  ];

  releaser = [
    sg
  ];

  system = [
    atomiutils
  ];
}
