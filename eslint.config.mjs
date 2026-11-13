import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // test/tsconfig.json includes both src/ and test/
        project: ["./test/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // node:test registers tests via top-level test()/describe() calls that return promises the
    // runner tracks itself; awaiting them is neither needed nor idiomatic.
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
  {
    // Fastify plugins, hooks and route handlers are async by convention (plugins must return a
    // promise or take a callback; sync hooks without `done` would hang) even when they await nothing.
    files: ["src/plugins/**/*.ts", "src/routes/**/*.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    // The gift-card core is pure (node:crypto and its own siblings only): no ORM, web framework,
    // entities, services, routes or config. Keeps domain rules testable without a database.
    files: ["src/gift-cards/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["typeorm", "typeorm/*"], message: "src/gift-cards is pure: no ORM." },
            { group: ["fastify", "fastify/*", "@fastify/*"], message: "src/gift-cards is pure: no web framework." },
            {
              group: ["**/entities", "**/entities/*", "**/services", "**/services/*", "**/routes", "**/routes/*", "**/config"],
              message: "src/gift-cards is pure: it must not depend on entities, services, routes or config.",
            },
          ],
        },
      ],
    },
  },
  {
    // Plain JS/config files are outside the TS project
    files: ["**/*.mjs", "**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  }
);
