# Snap — TypeScript attendee scaffold

Implement the contract in the packaged `SPEC.md`; the language-neutral public
tests are the acceptance criteria. Use strict TypeScript, avoid `any`, and use
`node:` prefixes for Node built-ins.

## Setup, build, run, and test

```bash
npm ci
npm run build                    # type-check
npm start -- <arguments>         # run the CLI
./snap <arguments>               # executable used by the public harness
```

The scaffold contains no private language-specific test suite. Run the packaged
language-neutral verifier from the repository root:

```bash
./capstones/snap/verify --lang ts
```

Production code should use Node built-ins; `tsx`, TypeScript, and Node typings
are development dependencies.
