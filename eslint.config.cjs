const globals = require('globals');
module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'test-output/**',
      'src/renderer/styles/tailwind-output.css',
    ],
  },
  {
    files: [
      'src/**/*.js',
      'tests/**/*.{js,cjs}',
      'scripts/**/*.cjs',
      'webpack.*.js',
      '*.config.cjs',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'no-undef': 'error',
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'constructor-super': 'error',
      'valid-typeof': 'error',
    },
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser, module: 'readonly' },
    },
  },
];
