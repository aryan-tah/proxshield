# Contributing to proxshield

Thanks for helping. proxshield has one job: keep personal data and injected instructions out of LLM calls without breaking the apps that make them. The most useful contributions make detection more accurate, keep more clients working, or make it easier to run.

## Ways to help

- **Report a missed or wrong detection.** Use the "Missed or wrong detection" form. Use realistic fake values, never real personal data.
- **Report a client that breaks.** If an SDK or framework works against OpenAI or Anthropic directly but fails through proxshield, that's a bug. Include the request and the error.
- **Add a detector** for a format that's missing (a national ID, a cloud provider's key format). Every detector needs positive and negative tests.
- **Fix something.** Issues labelled `good first issue` are scoped for a first PR.

## Development

You need Node 20 or newer.

```bash
git clone https://github.com/aryan-tah/proxshield
cd proxshield
npm install
npm run check        # lint, typecheck, tests
```

The default test run uses small fake models, so it's fast and needs no downloads. `npm run test:models` runs the real models (about 1.3 GB download the first time, including OpenAI Privacy Filter). `npm run bench` runs the benchmark.

## Pull requests

- Keep each PR to one change. Small PRs get reviewed fast.
- Add or update tests. Proxy changes need a test that pins the exact request sent upstream and the exact response returned.
- Detector changes need the benchmark numbers before and after (see `bench/README.md`).
- Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org/) style (`feat:`, `fix:`, `docs:`). The changelog is generated from them.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By taking part you agree to it.
