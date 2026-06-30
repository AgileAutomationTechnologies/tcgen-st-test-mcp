# Reproducible v0.1 Release Candidate Slice

## Goal

Turn the local compiler-backed validation proof into a reproducible release
candidate without changing MCP tool names or request shapes.

## Implementation Notes

- Keep STruC++ external and document the AAT `development` commit used for this
  Windows validation slice, based on upstream STruC++ 0.5.12.
- Add schema-backed validation and package/report schemas while preserving the
  current JSON fields.
- Make fixture and MCP smokes repeatable through npm scripts and CI.
- Gate retained workspace paths behind an explicit local environment flag.
- Keep unrelated dirty files in sibling repos out of this slice.

## Verification

- Run MCP typecheck, unit tests, native fixture sweep, MCP smoke, and pack dry
  run.
- Run STruC++ build/typecheck/version/native sample checks.
- Run the focused TcGen and cloud integration checks.
