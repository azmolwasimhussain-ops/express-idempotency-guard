import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts", "tsup.config.ts"],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest }
    },
    rules: {
      "@typescript-eslint/no-non-null-assertion": "error"
    }
  },
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"]
  },
  prettier
);
