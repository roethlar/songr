const tseslint = require("typescript-eslint");

// Publication boundary, §3 enforcement part one: nothing outside a walled root
// may import from inside one. The walled roots are excluded from the rule below
// so they can still import each other freely; everything else in src/ is
// subject to it.
//
// The pattern matches the import specifier, not a resolved path, because that
// is what no-restricted-imports sees. Every walled root is reached through a
// path segment named `native`, whether the specifier is relative
// (`../../native/client`, as the collapsed catalog route test writes it) or
// deeper (`../../server/native/client`), so one segment-anchored pattern covers
// all three backend roots — src/server/native, src/shared/native and
// src/tooling/native — including roots that do not exist yet.
//
// The single legitimate crossing is the §3 interface in src/server/libraryFeatures.ts,
// and it needs no exception here: it reaches its implementation through a
// specifier assembled at runtime, which is deliberately invisible to both the
// type-checker and this rule.
const WALLED_ROOTS = [
  "src/server/native/**",
  "src/shared/native/**",
  "src/tooling/native/**",
];

const forbiddenWallCrossing = {
  name: "publication-wall",
  ignores: WALLED_ROOTS,
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["**/native", "**/native/**"],
            message:
              "Publication boundary: code outside a walled root may not import from inside one. Depend on the product-vocabulary interface in src/server/libraryFeatures.ts instead (see .agents/plans/publication.md §3).",
          },
        ],
      },
    ],
  },
};

module.exports = tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "**/__tests__/"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  forbiddenWallCrossing,
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
