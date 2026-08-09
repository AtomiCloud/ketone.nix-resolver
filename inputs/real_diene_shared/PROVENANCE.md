# `real_diene_shared` — provenance

All six files under `workspace/` are the **verbatim** resolver-managed files of the diene
cascade's shared node, copied on 2026-08-09 from
`AtomiCloud/shared` at commit `99a297e94fb55c4f26707e43ae10af20595d89ff`
(working tree `/home/kirin/.kteam/mse4qqw4-b0c895b9/wt/shared`).

They are here because the repository's own fixtures did not contain a single
treefmt-formatted **multi-line function head**, which is the shape every canonical file
takes once its head grows past the print width. Two `atomi/nix@2` mergers matched the head
with a regex anchored to line 1 only:

- `parsePackages` produced `{ }:` for a body referencing `atomi`, `pkgs-2605` and
  `pkgs-unstable`;
- `parseShells` produced `{  }:` with no `with env;` prelude and no `inherit shellHook;`
  in any shell.

Both emitted unevaluable Nix and exited success. Hand-written fixtures had all agreed with
the parser's assumption, so nothing in the suite saw it. These files are the ones that did.

`nix/fmt.nix` additionally carries `prettier.excludes`, a list-valued program field the fmt
merger did not model and therefore dropped.

Do not reformat these files. Their exact bytes — including where the formatter chose to
break each head — are the point of the fixture.
