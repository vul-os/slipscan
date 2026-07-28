module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  extends: [
    "eslint:recommended",
    "plugin:react/recommended",
    "plugin:react/jsx-runtime",
    "plugin:react-hooks/recommended",
  ],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  settings: { react: { version: "18.2" } },
  plugins: ["react-refresh"],
  ignorePatterns: [
    "dist",
    "backend",
    "node_modules",
    "scripts",
    // A snapshot of the served static site, reverse-populated from
    // vulos-static — including a vendored, minified marked.umd.js that this
    // config has no business having an opinion about.
    "site",
    "*.config.js",
    "*.cjs",
  ],
  rules: {
    "react/prop-types": "off",
    "react-refresh/only-export-components": [
      "warn",
      { allowConstantExport: true },
    ],
    "no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "react/no-unescaped-entities": "off",
  },
  overrides: [
    {
      // shadcn/ui primitives and the app's context/theme providers idiomatically
      // colocate a hook (useTheme, useWorkspace) or cva variants alongside their
      // component. react-refresh/only-export-components is a dev-only Fast Refresh
      // nicety that does not apply to these deliberate patterns.
      files: [
        "src/components/ui/**",
        "src/components/theme-provider.jsx",
        "src/context/**",
      ],
      rules: { "react-refresh/only-export-components": "off" },
    },
    {
      // Playwright detects a fixture's dependencies by destructuring its first
      // argument, so a fixture that needs none is written `async ({}, use)`.
      // That is the framework's idiom, not an oversight.
      files: ["e2e/**"],
      rules: { "no-empty-pattern": "off" },
    },
  ],
};
