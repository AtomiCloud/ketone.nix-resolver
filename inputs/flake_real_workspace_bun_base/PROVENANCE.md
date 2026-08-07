# Real flake fixture provenance

Captured from the read-only `diene.all` repository on 2026-08-06 UTC:

| Fixture               | Source ref                | Ref commit                                 | `flake.nix` blob                           |
| --------------------- | ------------------------- | ------------------------------------------ | ------------------------------------------ |
| `workspace/flake.nix` | `authoritative/workspace` | `af23c2feccc8a91b20dece8e09d14f882d5d2aee` | `110404c936f23655edfb11a1ecb80106732018b1` |
| `bun-base/flake.nix`  | `authoritative/bun-base`  | `7fe9ff6df440fffa6e8660da3409511208865330` | `7c8633c338a9181aad578d0773ea315ac8da0fd9` |

The fixture files are byte-identical to those blobs. Refresh the refs and update
both commit and blob IDs whenever either real source changes.
