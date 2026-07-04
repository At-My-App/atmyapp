import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: [
      "**/coverage/**",
      "**/dist/**",
      "**/.astro/**",
      "**/node_modules/**",
    ],
  },
  {
    files: ["packages/**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      parser: tsParser,
      parserOptions: {
        sourceType: "module",
      },
    },
    rules: {},
  },
];
