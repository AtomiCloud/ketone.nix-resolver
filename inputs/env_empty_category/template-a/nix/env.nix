{ pkgs, packages }:
with packages;
{
  dev = [
    git
    pls
  ];

  infra = [
  ];
}
