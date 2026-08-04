// Lint config for the desktop app.
//
// Why this is a short allow-list rather than `recommendedTypeChecked`
// wholesale: the full recommended set was run against this tree first, and it
// produced 496 findings containing exactly ONE real defect — an `api.health()`
// chain with no `.catch()`, sitting directly below a sibling that had one.
// A gate at that signal-to-noise ratio teaches people to suppress it, which is
// worse than no gate. So every rule below is here because it was measured to
// carry signal on this codebase, and every rule left off is recorded with the
// evidence that took it off.
//
// Measured and DELIBERATELY NOT ENABLED:
//
//   @typescript-eslint/require-await (176 hits) — concentrated in
//     lib/api/mock.ts, whose methods are `async` BY DESIGN because they stand
//     in for an async API. The rule is right about the syntax, wrong about the
//     intent.
//
//   svelte/no-unused-svelte-ignore (98 hits) — false positives on this repo's
//     house style. In `<!-- svelte-ignore rule\n explanation -->` the prose
//     continuation is read as further ignore directives, so one documented
//     suppression reports as three unused ones. Explaining a suppression is a
//     habit worth keeping; the rule punishes it.
//
//   @typescript-eslint/no-unnecessary-type-assertion (118 hits) — almost all
//     `found[0]!` in tests. Redundant under this tsconfig, but defensive and
//     harmless; rewriting 118 call sites for a style rule is churn.
//
//   svelte/prefer-svelte-reactivity (9 hits) — all nine false positives here.
//     It flags any `new Set`/`new Map`, but every instance is local scratch
//     inside a pure function, or the correct `new Map(prev).set(...)`
//     reassignment. None is reactive state.
//
//   svelte/no-at-html-tags (1 hit) — `{@html logoMark}` in Sidebar.svelte is a
//     build-time SVG import, not user input.
//
// If one of those starts earning its place, enable it and delete its
// paragraph. Re-measure before assuming any count above still holds.

import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';

export default [
  {
    ignores: [
      'dist/**',
      'src-tauri/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.svelte'],
    plugins: { '@typescript-eslint': tseslint.plugin, svelte },
    rules: {
      // The rule that found the one real defect. An unawaited call whose
      // callee does not catch internally becomes a rejection nobody sees, and
      // in a double-entry app that is a posting error that never surfaces.
      '@typescript-eslint/no-floating-promises': 'error',
      // An async function handed to something expecting `void` — the same
      // failure wearing a different hat, and easy to write in a Svelte
      // event handler.
      '@typescript-eslint/no-misused-promises': 'error',
      // `await` on a non-promise is always a mistake, usually a refactor that
      // dropped an `async`.
      '@typescript-eslint/await-thenable': 'error',
      // Values that reached `any` through a cast or an untyped import. The
      // point of moving to TypeScript was that these get caught somewhere.
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.svelte'],
      },
    },
  },
];
