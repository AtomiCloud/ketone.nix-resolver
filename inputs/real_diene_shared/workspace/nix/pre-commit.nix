{
  packages,
  formatter,
  pkgs,
  pre-commit-lib,
  env,
}:
let
  # toolchain-smoke asserts the DECLARED env lists actually provide their binaries.
  envPath = pkgs.lib.makeBinPath (env.system ++ env.main ++ env.lint ++ env.dev);
in
pre-commit-lib.run {
  src = ../.;

  hooks = {
    treefmt = {
      enable = true;
      package = formatter;
      excludes = [
        "^\\.claude/skills/vendor/"
        "^Changelog\\.md$"
        "^docs/developer/CommitConventions\\.md$"
        "^infra/root_chart/"
      ];
    };

    a-dlint = {
      enable = true;
      name = "dlint";
      entry = "${packages.atomiutils}/bin/bash -c 'PATH=${envPath}:\$PATH ${packages.dlint}/bin/dlint lint'";
      pass_filenames = false;
      language = "system";
    };

    a-helm-lint = {
      enable = true;
      name = "Helm lint";
      entry = "${packages.infrautils}/bin/helm lint infra/root_chart";
      files = "^infra/root_chart/.*";
      pass_filenames = false;
      language = "system";
    };

    a-infisical = {
      enable = true;
      name = "Secrets scan";
      entry = "${packages.infisical}/bin/infisical scan . -v --redact";
      pass_filenames = false;
      language = "system";
    };

    a-infisical-staged = {
      enable = true;
      name = "Staged secrets scan";
      entry = "${packages.infisical}/bin/infisical scan git-changes --staged -v --redact";
      pass_filenames = false;
      language = "system";
    };

    # The selector is directory-shaped on purpose: every standard under
    # docs/standards/ and every first-level skill trigger is linted, so adding a
    # topic needs no edit here. Vendored skills sit deeper than one level and are
    # ignored again by .markdownlint-cli2.jsonc.
    a-markdownlint = {
      enable = true;
      name = "Markdown lint";
      entry = "${pkgs.markdownlint-cli2}/bin/markdownlint-cli2";
      files = "^(CLAUDE\\.md|README\\.md|docs/standards/.*\\.md|\\.claude/skills/[^/]+/SKILL\\.md)$";
      pass_filenames = true;
      language = "system";
    };

    a-releaser-commit = {
      enable = true;
      name = "Conventional commit";
      entry = "${packages.releaser}/bin/releaser lint-commit -c release.yaml";
      stages = [ "commit-msg" ];
      pass_filenames = true;
      language = "system";
    };

    a-skills-sync = {
      enable = true;
      name = "Vendored skills";
      entry = "${packages.skills-sync}/bin/skills-sync sync --frozen";
      pass_filenames = false;
      language = "system";
    };

    # -x + SCRIPTDIR: staged-file batching splits scripts from their sources,
    # so ShellCheck must follow source= directives itself.
    a-shellcheck = {
      enable = true;
      name = "Shellcheck";
      entry = "${packages.shellcheck}/bin/shellcheck -x --source-path=SCRIPTDIR";
      files = ".*\\.sh$";
      pass_filenames = true;
      language = "system";
    };
  };
}
