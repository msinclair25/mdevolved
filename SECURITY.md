# Security policy

MDevolved protects owner-controlled Source data, agent authorization, Project
continuity, and encrypted recovery. Security reports are handled separately
from feature requests and general support.

## Supported code

Security fixes land on `main` and in the current managed deployment. Alpha tags
and older deployments may be superseded instead of receiving a backport.

## Report a vulnerability

If GitHub shows **Report a vulnerability**, use that private channel.
Otherwise, email [support@mdevolved.com](mailto:support@mdevolved.com).

Include:

- the affected MDevolved surface and version or commit;
- the smallest reproducible sequence using synthetic data;
- the expected and observed authorization boundary;
- the likely impact; and
- any suggested remediation.

Do not include real vault contents, access tokens, recovery identities,
pairing grants, session material, or private user information. Do not open a
public issue for an undisclosed vulnerability.

Please allow time to reproduce, repair, and deploy a fix before public
disclosure. MDevolved does not offer a bug bounty or guaranteed response-time SLA.

## Security scope

High-priority reports include authentication or pairing bypass, cross-vault
access, path traversal, malicious Markdown execution, token leakage, backup
decryption weakness, restore corruption, and unintended disclosure through
logs or deployment metadata.

## Security model

The repository's threat model, trust boundaries, and security invariants are
documented in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).
