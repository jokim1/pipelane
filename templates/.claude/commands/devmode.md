Switch or check the repo's development mode (build or release).

Run:

```bash
npm run workflow:devmode -- $ARGUMENTS
```

If no arguments are provided, default to `status`.

Display the output directly. The key line is:

- `Dev Mode: [build]`
- `Dev Mode: [release]`

If release mode is blocked, show the blocked surfaces and tell the user to run `npm run workflow:setup`.
