# Security policy

## Supported versions

Security fixes are intended for the latest published release. Check the package registry for the current release before upgrading.

## Reporting a vulnerability

Please do not post exploitable details in a public issue. Use GitHub's private vulnerability reporting for this repository after it is enabled, or contact a project maintainer privately. Include the affected version, impact, reproduction steps, and a suggested fix if available.

Do not include customer data, live idempotency keys, credentials, or production response bodies in a report.

## Security design notes

- The built-in memory adapter is process-local and bounded; it is not a distributed security boundary.
- Custom storage must make reservations atomic and protect writes/deletes with reservation IDs.
- Scope keys to trusted authenticated identities where separate users must not share operation results.
- Cached response bodies may contain sensitive data. Protect custom storage and keep TTLs appropriate.
