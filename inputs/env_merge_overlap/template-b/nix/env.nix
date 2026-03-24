{ pkgs, packages }:
with packages;
{
  dev = [
    git
    shellcheck
    helmlint
  ];

  lint = [
    treefmt
  ];
}
