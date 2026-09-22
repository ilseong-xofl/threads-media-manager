import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.webpack/**', 'out/**', 'node_modules/**', '.venv/**', 'plugins/**', '.agents/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mjs'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
);
