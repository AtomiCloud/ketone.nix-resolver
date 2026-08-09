{ env, formatter, packages, pkgs, pre-commit-lib }:
let
  # toolchain-smoke asserts the DECLARED env lists actually provide their binaries.
  envPath = pkgs.lib.makeBinPath (env.system ++ env.main ++ env.lint ++ env.dev);
in
pre-commit-lib.run {
  src = ../.;

  hooks = {
    a-dlint = {
      enable = true;
      entry = "${packages.atomiutils}/bin/bash -c 'PATH=${envPath}:\$PATH ${packages.dlint}/bin/dlint lint'";
      language = "system";
      name = "dlint";
      pass_filenames = false;
    };

    a-helm-lint = {
      enable = true;
      entry = "${packages.infrautils}/bin/helm lint infra/root_chart";
      files = "^infra/root_chart/.*";
      language = "system";
      name = "Helm lint";
      pass_filenames = false;
    };

    a-infisical = {
      enable = true;
      entry = "${packages.infisical}/bin/infisical scan . -v --redact";
      language = "system";
      name = "Secrets scan";
      pass_filenames = false;
    };

    a-infisical-staged = {
      enable = true;
      entry = "${packages.infisical}/bin/infisical scan git-changes --staged -v --redact";
      language = "system";
      name = "Staged secrets scan";
      pass_filenames = false;
    };

    a-markdownlint = {
      enable = true;
      entry = "${pkgs.markdownlint-cli2}/bin/markdownlint-cli2";
      files = "^(CLAUDE\\.md|README\\.md|docs/standards/.*\\.md|\\.claude/skills/[^/]+/SKILL\\.md)$";
      language = "system";
      name = "Markdown lint";
      pass_filenames = true;
    };

    a-releaser-commit = {
      enable = true;
      entry = "${packages.releaser}/bin/releaser lint-commit -c release.yaml";
      language = "system";
      name = "Conventional commit";
      pass_filenames = true;
      stages = [
        "commit-msg"
      ];
    };

    a-shellcheck = {
      enable = true;
      entry = "${packages.shellcheck}/bin/shellcheck -x --source-path=SCRIPTDIR";
      files = ".*\\.sh$";
      language = "system";
      name = "Shellcheck";
      pass_filenames = true;
    };

    a-skills-sync = {
      enable = true;
      entry = "${packages.skills-sync}/bin/skills-sync sync --frozen";
      language = "system";
      name = "Vendored skills";
      pass_filenames = false;
    };

    treefmt = {
      enable = true;
      excludes = [
        "^Changelog\\.md$"
        "^\\.claude/skills/vendor/"
        "^docs/developer/CommitConventions\\.md$"
        "^infra/root_chart/"
      ];
      package = formatter;
    };
  };
}
