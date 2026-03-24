{ pkgs, packages, extra }:
with packages;
{
  dev = [
    shellcheck
  ];
}
