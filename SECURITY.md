# Security Policy

Butterfly Code runs shell commands and edits files on your machine on behalf of
a language model, so we take security reports seriously.

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) instead.
Include the version (`butterfly --version`), your OS, and steps to reproduce.

We aim to acknowledge reports within 3 working days and to ship a fix or
mitigation for confirmed issues as quickly as their severity requires.

## Supported versions

Only the latest released version receives security fixes.

## Scope

In scope: permission bypasses (a tool running without the approval the
permission rules require), path traversal outside the workspace, secret
leakage (API keys, `.env` content) into logs or providers that should not see
it, unsafe defaults, and supply-chain issues in our release artifacts.

Out of scope: actions you explicitly allowed (for example `"*": "allow"`),
and model output quality.
