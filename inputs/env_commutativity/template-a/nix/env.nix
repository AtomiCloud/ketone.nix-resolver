{ pkgs, packages }:
with packages;
{
  system = [
    atomiutils
  ];

  dev = [
    git
    pls
  ];

  lint = [
    treefmt
    shellcheck
  ];
}
