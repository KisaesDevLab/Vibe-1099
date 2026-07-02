// Minimal flat config — correctness rules only; formatting/style is left to convention.
// Typechecking (tsc --noEmit) is the primary static gate; eslint catches logic footguns.
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'render/**', '**/*.js', '**/*.mjs'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'warn',
      eqeqeq: ['error', 'smart'],
      '@typescript-eslint/no-floating-promises': 'off', // requires type info; tsc strict covers most
      '@typescript-eslint/no-misused-new': 'error',
    },
  },
];
