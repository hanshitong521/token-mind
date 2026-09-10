# Acceptance Criteria

- Build passes.
- All mapper tests pass.
- No production schema change.

# Safety

Never run rm -rf against the production volume. Deployment is read-only for
agents; a human must apply any schema migration.
