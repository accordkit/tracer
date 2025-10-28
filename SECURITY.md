# Security Policy

## Supported Versions

We actively maintain the latest minor release of **Tracer**.  
Older versions may continue to function but will **not** receive security updates.

| Version | Supported |
|----------|------------|
| 1.x.x (main) | ✅ |
| < 1.0.0 | ❌ |

If you’re using a fork or pinned commit, please keep your dependencies up to date with the main branch to receive fixes and improvements.

---

## Reporting a Vulnerability

If you discover a security vulnerability within Tracer or any of its official packages, please report it **privately** and **responsibly**.

📧 **Email:** [security@accordkit.dev](mailto:security@accordkit.dev)

> Do **not** open a public GitHub issue for security reports.  
> We take all disclosures seriously and will respond promptly.

---

## Disclosure Process

1. **Report privately** via email with:
   - A description of the issue
   - A minimal reproducible example, if possible
   - Affected versions or environment details
2. We’ll acknowledge receipt **within 48 hours**.
3. A maintainer will:
   - Confirm and reproduce the issue
   - Assess impact and scope
   - Work with you on a coordinated fix and disclosure timeline
4. Once a patch is available, we’ll release a new version and credit the reporter (if desired).

---

## Security Best Practices

When using Tracer in production:
- Always use secure endpoints (HTTPS) for HTTP or browser sinks.
- Limit access to ingestion endpoints to authorized sources.
- Avoid embedding secret keys or tokens directly in client-side code.
- Validate and sanitize all received telemetry payloads on your server.
- Keep dependencies up to date with `pnpm up -L`.

---

## Coordinated Disclosure

We follow responsible disclosure principles:
- Do **not** publish exploits before we release a patch.
- If a third-party dependency is affected, we’ll coordinate with its maintainers.
- Public disclosure will occur only after a fix is available or a reasonable time window has passed.

---

## Contact

For general security-related inquiries (non-vulnerability), contact:
📧 **security@accordkit.dev**

For urgent issues or embargoed disclosures, please use **PGP-encrypted email** if available (key to be published later).

---

*Your help keeping Tracer and the AI observability ecosystem secure is greatly appreciated.*  
🙏 Thank you for reporting vulnerabilities responsibly.
