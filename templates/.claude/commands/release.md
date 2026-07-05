<!-- pipelane:command:release -->
Enable or inspect the optional release module for this repo.

Run:

```bash
npm run pipelane:release -- $ARGUMENTS
```

Common forms:

- `{{ALIAS_RELEASE}} status`
- `{{ALIAS_RELEASE}} enable`
- `{{ALIAS_RELEASE}} doctor --probe`

Behavior:

1. `status` is read-only and explains staging and production readiness.
2. `enable` creates the machine-local deploy config state that release safety uses.
3. `doctor` delegates to the existing deploy-config and probe diagnostics.
4. CI or automation should keep using `pipelane run release-check` when it needs
   a non-zero exit code on blocked readiness.

Release is for repos where production must stay stable and staging must prove
the same merged SHA before production moves. It records evidence and readiness;
it does not run product QA itself.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
