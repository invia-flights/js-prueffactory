module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', console: 'readonly' },
    },
    rules: {
      'no-unused-vars': 'error',
      'no-console': 'error',
      eqeqeq: 'warn',
    },
  },
];
