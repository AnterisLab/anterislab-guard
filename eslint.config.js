
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  globalThis: 'readonly',
  fetch: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  Headers: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  ReadableStream: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'package-lock.json',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['test/**/*.mjs', 'scripts/**/*.mjs', 'bench/**/*.mjs'],
    languageOptions: {
      globals: nodeGlobals,
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `const guard = this` inside wrap/wrapFn captures the Guard instance
      // for the Proxy handler, whose `this` is the Proxy, not the Guard.
      // The alias is required and intentional.
      '@typescript-eslint/no-this-alias': [
        'error',
        { allowedNames: ['guard'] },
      ],
    },
  },
  {
    // `boundedString` deliberately matches control characters to reject them
    // in claim fields. The regex IS the check, not a smell.
    files: ['src/shared/killswitch-token.ts'],
    rules: {
      'no-control-regex': 'off',
    },
  },
);
