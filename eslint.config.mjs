// ESLint flat config for the whole monorepo (run from the root: `npm run lint`).
//
// Introduced on an existing codebase, so rules that the current code already
// violates are set to "warn" — CI fails only on errors. Tighten a rule to
// "error" once its warnings are fixed. rules-of-hooks is an error from day one:
// conditional hooks are always a bug.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import nextPlugin from '@next/eslint-plugin-next'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      'apps/web/worker.js',
      'apps/web/next-env.d.ts',
      'e2e/test-results/**',
      'e2e/playwright-report/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node },
    },
    linterOptions: {
      // Many files carry eslint-disable comments written for rules that were
      // never actually enforced; don't turn each one into a warning.
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // Existing-code baseline (warn, not error)
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      'no-empty': 'warn',
      'no-useless-escape': 'warn',
      'no-control-regex': 'warn',
      'no-case-declarations': 'warn',
      'no-constant-condition': 'warn',
      'no-async-promise-executor': 'warn',
      'no-prototype-builtins': 'warn',
      'no-cond-assign': 'warn',
      'no-fallthrough': 'warn',
      'prefer-const': 'warn',
    },
  },

  // ── Next.js app ─────────────────────────────────────────────────────────────
  {
    files: ['apps/web/**/*.{ts,tsx,js,jsx,mjs}'],
    plugins: {
      '@next/next': nextPlugin,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      '@next/next/no-img-element': 'warn',
      '@next/next/no-html-link-for-pages': 'off', // Pages Router rule; ORION uses the App Router
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ── Tests ───────────────────────────────────────────────────────────────────
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,mjs}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
