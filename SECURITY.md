# Security policy

## Supported versions

Security fixes go into the latest release.

## Reporting a vulnerability

Please don't open a public issue for security problems. Report them privately through GitHub: **Security → Report a vulnerability** on this repository. You'll get an acknowledgement within three days.

proxshield sits between applications and model providers, so it sees prompts, responses and provider API keys. Things worth reporting include:

- a way to make proxshield log, store or leak the original value behind a placeholder
- a way to get personal data through to the provider when its policy is `redact` or `block`
- restoring one request's values into another request's response
- forwarding a request to a host other than the configured upstream
- bypassing proxshield's own API key check
- a single request that exhausts the server

Missed detections (a phone number format it doesn't know, an injection the model misses) are ordinary bugs. Use the "Missed or wrong detection" issue form for those.
