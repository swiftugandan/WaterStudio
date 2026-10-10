# Contributing to WaterStudio

Thank you for helping. This file says how work flows in this repository.

## Trunk-based development

- `main` is the only long-lived branch and is always releasable: CI must be green on every commit.
- Make small changes. A change lands in hours, not weeks. Prefer several small commits to one large one.
- Unfinished features land behind a flag or simply unreachable from the UI, never on a long-lived branch.
- Maintainers may commit directly to `main` after running the checks below locally. Everyone else opens a
  short-lived pull request against `main`; it is merged (squash or rebase, never a merge commit) once CI passes
  and a maintainer has reviewed it.
- A commit that breaks `main` is reverted first and fixed second.

## Before you commit

```sh
cd engine && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
oracle/parity.sh          # if you touched anything under engine/
```

`oracle/parity.sh` fails if a network that passed before no longer matches OWA-EPANET. If your change fixes
a network listed in `oracle/known-failures.txt`, remove it from that list in the same commit.

## Commit messages

Use the imperative mood and a scope: `engine: handle closed PCVs in the status check`. Explain *why* in the
body when it is not obvious. Reference the issue (`Fixes #12`) when there is one.

## Numerical changes

Any change that can move a computed number must say, in its commit message, which networks' results moved and
by how much (the parity report shows it). Never loosen a tolerance in `oracle/compare.py` to make a change pass;
open an issue explaining why the tolerance is wrong instead.

## Clean-room rule

Do not read, copy or adapt code from projects whose licences conflict with ours. In particular, the
**epanet-js application** (github.com/epanet-js/epanet-js) is under the Functional Source License; contributors
must not look at its source while working on WaterStudio. MIT, Apache-2.0, BSD and public-domain sources (OWA-EPANET,
EPA EPANET, epanet-rs, PowerStudio) are fine; credit them where you use their ideas or code.

## AI-assisted contributions

Much of WaterStudio is written with AI assistance. The same rules apply to every contribution, however it was
produced: it must pass review and CI, the contributor must understand and stand behind it, and AI tools must be
credited with a `Co-Authored-By` trailer.

## Licence of contributions

By contributing, you agree that your contributions are dual-licensed under MIT and Apache-2.0, as the project is.
