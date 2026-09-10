const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  {
    // *.local.* are machine-local scratch probes: untracked, gitignored
    // (see a7fc972), and never part of what the repo ships or verifies.
    ignores: ["dist/", "node_modules/", "**/__tests__/", "**/*.local.ts", "**/*.local.mjs"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // Roon APIs have no type definitions and only support require()
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      // EventEmitter typed interface merging pattern
      "@typescript-eslint/no-unsafe-declaration-merging": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            attributes: false,
          },
        },
      ],
    },
  }
);
