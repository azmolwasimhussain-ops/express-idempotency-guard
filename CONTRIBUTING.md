# Contributing

Thanks for helping improve `express-idempotency-guard`.

## Before submitting a change

1. Check existing issues and pull requests for related work.
2. For behavior changes, add a test that exercises the request and storage behavior.
3. Update the README or changelog when the public API or behavior changes.
4. Keep adapters honest about their atomicity, expiry, and failure guarantees.

## Local workflow

```sh
npm install
npm run lint
npm run format
npm run typecheck
npm test
npm run build
npm run pack
npm run pack:check
```

The test suite uses Vitest and Supertest. Integration tests exercise real Express request/response cycles with Express 4 and Express 5.

## Pull requests

- Explain the user-visible behavior and any compatibility impact.
- Include tests for regressions and concurrency-sensitive behavior.
- Do not include credentials, private request data, generated `dist/` files, or package tarballs.
- Keep a pull request focused so storage, fingerprinting, and response handling changes can be reviewed independently.

## Security issues

Please follow the [security policy](https://github.com/azmolwasimhussain-ops/express-idempotency-guard/blob/main/SECURITY.md) for private vulnerability reporting.
