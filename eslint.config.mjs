import tseslint from 'typescript-eslint'

export default tseslint.config({
  files: [
    'src/lib/admin/resource-owner.mts',
    'src/lib/admin/key-scope.mjs',
    'src/lib/pool/pool-scheduler.mjs',
    'src/lib/pool/failover-runner.mjs',
    'src/lib/db/adapters/postgres/**/*.{mjs,mts}',
    'src/lib/protocol/handle-protocol.mjs',
    'src/lib/protocol/user-count-tokens.mjs',
  ],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { project: './tsconfig.async.json', tsconfigRootDir: import.meta.dirname },
  },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false, checkThenables: true }],
    '@typescript-eslint/no-misused-promises': 'error',
  },
}, {
  files: ['src/**/*.mts'],
  rules: { '@typescript-eslint/no-explicit-any': 'error' },
})
