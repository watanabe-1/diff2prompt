import js from "@eslint/js";
import eslintPluginVitest from "@vitest/eslint-plugin";
import eslintConfigPrettier from "eslint-config-prettier";
import eslintPluginImport from "eslint-plugin-import";
import eslintPluginUnusedImports from "eslint-plugin-unused-imports";
import tseslint from "typescript-eslint";

/** @type {import("eslint").Linter.Config[]} */
const config = [
  {
    files: ["*.ts"],
  },
  {
    ignores: [
      "**/node_modules",
      "**/dist",
      "**/bin",
      "**/eslint.config.mjs",
      "**/vitest.config.ts",
      "./build.ts",
    ],
  },
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
  },
  {
    name: "eslint/recommended",
    rules: js.configs.recommended.rules,
  },
  ...tseslint.configs.recommended,
  {
    plugins: {
      import: eslintPluginImport,
    },
    rules: {
      "import/order": [
        "error",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            ["parent", "sibling"],
            "index",
            "object",
            "type",
          ],
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
    },
  },
  {
    plugins: {
      "unused-imports": eslintPluginUnusedImports,
    },
  },
  {
    name: "prettier/config",
    ...eslintConfigPrettier,
  },
  {
    name: "project-custom",
    rules: {
      eqeqeq: "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: "return" },
      ],
      "spaced-comment": [
        "error",
        "always",
        {
          exceptions: ["-"],
          markers: ["!", "/"],
        },
      ],
    },
  },
  {
    files: ["src/**/*.test.ts"],
    plugins: {
      vitest: eslintPluginVitest,
    },
    rules: {
      ...eslintPluginVitest.configs.recommended.rules,
      "vitest/consistent-test-it": ["error", { fn: "it" }],
      "vitest/require-top-level-describe": ["error"],
    },
    settings: {
      vitest: {
        typecheck: true,
      },
    },
    languageOptions: {
      globals: {
        ...eslintPluginVitest.environments.env.globals,
      },
    },
  },
];

export default config;
