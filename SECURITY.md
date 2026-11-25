# Security policy

## Scope and support

CityShield is a research MVP, not a production-hardened or life-safety service. Security reports are welcome for the current main branch. No support lifetime or response-time SLA is promised.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/bibek200620/cityshield/security/advisories/new) if available. If unavailable, contact the [repository maintainer](https://github.com/bibek200620) through a private channel agreed with them. Do not post exploit details, secrets or personal data in public issues. A public issue requesting a private contact method may omit all sensitive details.

Include the affected commit/version, component, impact, minimal safe reproduction, environment and suggested remediation if known. Redact credentials, precise personal locations and provider tokens. Allow maintainers a reasonable opportunity to investigate before public disclosure. Do not test systems or accounts without authorization, access other users' data or disrupt external providers.

## Deployment and data handling

- Keep provider keys in backend environment variables; rotate any exposed keys.
- Do not deploy the example database credentials or permissive development settings publicly.
- Use HTTPS, restrictive CORS, appropriate access controls, rate limiting and dependency monitoring.
- Browser geolocation is permission-based; route endpoints and place searches may be sent to external providers. Avoid sharing sensitive coordinates in reports.
- Treat hazard and route outputs as research estimates, not official warnings or certified safe routes.

See [data sources](docs/DATA_SOURCES.md) for external provider terms and [contribution guidance](CONTRIBUTING.md) for normal bugs.
