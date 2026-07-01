# Security Policy

## Supported versions

The toolkit is pre-1.0. Security fixes are applied to the latest published
version only.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report them privately via GitHub's
[private vulnerability reporting](https://github.com/shaoyulan/ai-application-toolkit/security/advisories/new),
or email the maintainer at 45042818+shaoyulan@users.noreply.github.com.

Include:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected package(s) and version(s).

You can expect an initial acknowledgement within a few business days. Once a
fix is available it will be released and the advisory published.

## Scope

This project is a set of libraries. Note that:

- Tool `execute` functions, guardrails, and provider adapters run code you
  supply or configure — validate untrusted input in your own tools.
- Provider adapters read API keys from environment variables; never commit
  secrets to source control.
