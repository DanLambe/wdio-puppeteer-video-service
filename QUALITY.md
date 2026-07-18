# Quality Baseline

This file records the pre-1.0 quality floor. Each implementation chunk must meet
or improve this floor and publish its own test and SonarQube checkpoint results.

## Chunk 0 baseline

Captured on 2026-07-17 before product-code changes.

### Local verification

- Unit tests: 182 passed.
- Coverage: 81.48% statements, 72.49% branches, 82.84% functions, and 81.54% lines.
- Production dependency audit: no vulnerabilities (`npm audit --omit=dev`).
- Full development audit: six moderate advisories in the WebdriverIO Cucumber
  development dependency tree. They originate from Cucumber's transitive
  dependencies and are retained until WebdriverIO provides a compatible update;
  incompatible overrides are not permitted merely to clear the audit output.

The enforced local coverage floor is 80% for statements, lines, and functions,
and 70% for branches. CI generates `coverage/lcov.info` for SonarQube import.

### SonarQube Cloud

- Quality gate: `OK`.
- Lines of code: 5,975.
- Cyclomatic complexity: 1,164.
- Cognitive complexity: 692.
- Duplicated-line density: 0.0%.
- Bugs: 0.
- Vulnerabilities: 0.
- Code smells and violations: 1 pre-existing test-stability finding
  (`typescript:S5973` in the intentional retry fixture).
- Coverage: absent from the server baseline because LCOV was not previously
  imported.

Pull requests from branches in this repository run CI-based SonarQube analysis.
The repository must provide a `SONAR_TOKEN` GitHub Actions secret, and SonarQube
Cloud automatic analysis must be disabled to avoid duplicate analysis. Fork pull
requests intentionally skip the secret-bearing scan and cannot satisfy the
pre-1.0 completion gate until a trusted-branch analysis is run.
