import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.wrangler/**', 'apps/worker/worker-configuration.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-namespace': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  { files: ['**/*.mjs', 'scripts/**'], languageOptions: { globals: { process: 'readonly', console: 'readonly', fetch: 'readonly' } } },
);
