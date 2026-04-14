Deploy the merged SHA for this repo.

Run:

```bash
npm run workflow:deploy -- $ARGUMENTS
```

Expected arguments:

- `staging [surfaces...]`
- `prod [surfaces...]`

Release mode requires staging before production for the same merged SHA and surface set.

Display the output directly. Report the environment, SHA, surfaces, and next step.
