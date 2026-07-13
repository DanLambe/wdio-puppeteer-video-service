# Project test rules

- Use Node.js 24, TypeScript, and ESM conventions, including explicit `.js` extensions for relative runtime imports.
- Keep strong typing where practical and use curly braces for control flow.
- Use no semicolons unless syntax requires them.
- Prefer the existing package scripts and artifact assertions.
- Keep changes focused, dependency-light, and compatible with CPU-only parallel CI workers.
- Do not weaken video artifact assertions to make a failing E2E run pass.
