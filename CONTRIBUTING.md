# Contributing to Tracer

Thanks for your interest in contributing to **Tracer**! 🎉  
Tracer is an open-source observability and tracing kit designed for AI and distributed applications.  
We welcome contributions of all kinds; code, documentation, testing, and ideas.

---

## 🧱 Project Overview

Tracer consists of modular libraries and sinks for collecting and delivering structured trace events:
- `core`: tracing primitives, buffering, and event models
- `sinks`: output targets (file, HTTP, browser, etc.)
- `tests`: full coverage with Vitest

Each sink follows the same guarantees:
- No overlapping flushes
- Deterministic shutdown
- Full buffer drain with awaited I/O
- Safe browser delivery and graceful failure handling

---

## 🧭 How to Contribute

We use `pnpm` as the default package manager (faster + deterministic).

### 1. Fork & Clone

```bash
git clone https://github.com/<your-username>/tracer.git
cd tracer
pnpm install
```

### 2. Run the Test Suite

```bash
pnpm test
```

### 3. Make Your Changes

Follow the existing code style and naming conventions.
Each sink or buffer component should be deterministic and well-tested.

Before committing:
- Make sure Vitest passes (pnpm test)
- Run eslint and prettier to format your code
- Add or update unit tests for your changes

### 4. Commit Guidelines

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) for clean history:
```
feat(http-sink): add Retry-After support and idempotency keys
fix(file-sink): prevent race on overlapping flush
docs: update contributing guide
```

### 5. Submit a Pull Request

- Base branch: main
- Use a clear title and description
- Include context for why your change is needed

A maintainer will review your PR and may request small adjustments.
Please be responsive to review comments; collaborative iteration is part of the process.


## 🧪 Testing and Coverage

We aim for 90–100% coverage on all core sinks and buffer logic.
Test with:
```bash
pnpm test --coverage
```

- Use Vitest (no Jest)
- For browser features, use fake-indexeddb and stubbed globals
- Always test edge cases: overlapping flushes, buffer overflow, network failures, etc.


## 🧹 Code Style

- Language: TypeScript
- Linting: ESLint + Prettier
- No any or unknown unless absolutely unavoidable
- Prefer explicit types for all public APIs
- Document key methods and classes with JSDoc


## 🧩 Branching & Releases

- main: stable, production-ready
- dev: active development (if used)
- Versioning: [Semantic Versioning (SemVer)](https://semver.org/)

When merging, maintainers will:
- Squash commits
- Update CHANGELOG.md
- Tag the release


## 🫶 Community & Support

- Discussions: GitHub Discussions (once enabled)
- Issues: Use GitHub Issues for bugs and feature requests
- Security reports: Please email the maintainer privately (no public disclosure)


## 🧑‍💻 Developer Notes

- FileSink and HttpSink should always guard flush() to prevent overlapping operations.
- BrowserSink should gracefully degrade (use fetch fallback).
- For any new sink, ensure deterministic shutdown (close() drains all).
- Buffered logic must respect OverflowPolicy.
