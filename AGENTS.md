# Project rules

- Never use emojis anywhere: code, comments, log messages, strings, documentation.
- Never add `Co-Authored-By` or any AI attribution to commit messages.
- Limit comments to a strict minimum. Almost never add comments, except on non-trivial code, non-self-explanatory function arguments, and class definitions.
- Do not remove existing comments unless they are directly related to what you are changing.

Repo-specific:

- Run `node eval/verify.mjs` after touching any fixture, validator, or server code, and get it green before committing. The gate costs nothing, and it is the only thing between a well-meaning edit and a silently broken task.
- For interaction tasks, graded values must not be derivable from `pages/`: mint them in `sites/` per session or grade server-observed actions. Pure extraction tasks may grade published page content; do not put unpublished answer-only artifacts under `pages/`.
- Nothing under `pages/` may say or imply a site is a test fixture.
- Read `docs/authoring-fixtures.md` before writing or editing a fixture. Read `docs/process.md`, "Read before you edit", before fixing a validator: work test-first, in small batches, and let the gate arbitrate.
