# Changelog

## model-guard 1.0.0 (2026-10-12)

First public release.

- `default`: the model for a subagent whose call names none (no `model`, or `inherit`).
- `rules`: a JSON array of `{"match", "model"}` pairs for calls that name a model; the first match decides.
- `forks`: `passthrough` (the default) or `deny`.
- Empty settings leave every spawn exactly as Claude Code would run it.
- A broken `rules` setting turns every rule off and says why in one line at session start.
- A workflow script's agents always pass through untouched.
