// @ts-check
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = (/** @type {string} */ p) => path.join(root, 'src', p);

/**
 * Feature folders under ui/features. Planned ones are listed explicitly so the
 * boundary rules exist before the folders do; any extra folder is picked up.
 */
const featuresDir = src('ui/features');
const features = [
  ...new Set([
    'rail',
    'sidebar',
    'chat',
    'members',
    'settings',
    'switcher',
    'onboarding',
    'spaces',
    ...(existsSync(featuresDir)
      ? readdirSync(featuresDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : []),
  ]),
];

/**
 * Every source file outside a given backend adapter folder. Add a new
 * adapter's folder here (and register it in src/app/backends.ts).
 */
const adapterZones = ['mock', 'signal-cli'].map((adapter) => ({
  target: [
    src('*.{ts,tsx}'),
    src('ui/**'),
    src('test/**'),
    src('core/!(backend)/**'),
    src('core/backend/*.ts'),
    src(`core/backend/!(${adapter})/**`),
  ],
  from: src(`core/backend/${adapter}`),
  message: 'Backend adapters may only be imported by the composition root (src/app).',
}));

/** Architecture boundaries from docs/PLAN.md §3. Applies to all source files. */
const boundaryZones = [
  {
    target: src('core'),
    from: [src('ui'), src('app')],
    message: 'core/ must not depend on ui/ or app/.',
  },
  {
    target: src('core/domain'),
    from: src('core'),
    except: ['./domain'],
    message: 'core/domain is the leaf layer and must not import other core modules.',
  },
  {
    target: src('core/lib'),
    from: src('core'),
    except: ['./lib'],
    message: 'core/lib is a leaf utility layer and must not import other core modules.',
  },
  {
    target: src('ui/primitives'),
    from: [src('ui/features'), src('core'), src('app')],
    message: 'ui/primitives are pure presentational components.',
  },
  {
    target: src('ui/hooks'),
    from: [src('ui/features'), src('ui/plugins')],
    message: 'ui/hooks sit below features and plugins: they must not import them.',
  },
  {
    target: src('ui/plugins'),
    from: src('ui/features/**'),
    except: [src('ui/features/*/index.{ts,tsx}')],
    message: 'ui/plugins may use a feature only through its index.ts.',
  },
  ...features.map((feature) => ({
    target: src(`ui/features/${feature}/**`),
    from: src('ui/features/**'),
    except: [src(`ui/features/${feature}/**`), src('ui/features/*/index.{ts,tsx}')],
    message: 'Import another feature only through its index.ts.',
  })),
];

/**
 * Production-only boundaries (tests may boot the whole app): built-in plugins
 * reach the app through AppServices / PluginContext, never the composition root.
 */
const appZones = [
  {
    target: src('ui/plugins'),
    from: src('app'),
    message: 'ui/plugins must not import the composition root (use PluginContext).',
  },
];

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', 'src/test/lint-fixtures/**'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
      parserOptions: {
        // Explicit projects (not the solution-style root) so lint sees the
        // same strict flags as tsc, e.g. noUncheckedIndexedAccess.
        project: ['./tsconfig.app.json', './tsconfig.node.json'],
        tsconfigRootDir: root,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'import-x': importX,
    },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ project: './tsconfig.app.json' }),
      ],
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Use named exports only (PLAN §7).',
        },
      ],
      'import-x/no-cycle': 'error',
      'import-x/no-restricted-paths': [
        'error',
        { zones: [...boundaryZones, ...adapterZones, ...appZones] },
      ],
    },
  },
  {
    // core/ is React-free so plugins and services can run headless.
    files: ['src/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: 'core/ must not import React.' },
            { name: 'react-dom', message: 'core/ must not import React.' },
            { name: 'zustand', message: "Use 'zustand/vanilla' in core/." },
          ],
          patterns: [
            { group: ['react/*', 'react-dom/*'], message: 'core/ must not import React.' },
            {
              group: ['zustand/react', 'zustand/traditional'],
              message: 'core/ must be React-free.',
            },
          ],
        },
      ],
    },
  },
  {
    // Tests may reach for the mock adapter directly; all other boundaries still apply.
    files: ['src/**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    rules: {
      'import-x/no-restricted-paths': ['error', { zones: boundaryZones }],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['vite.config.ts', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
