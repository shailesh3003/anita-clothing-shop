import js from '@eslint/js'
export default [{ ignores: ['node_modules'] }, { files: ['**/*.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', URL: 'readonly', fetch: 'readonly' } }, rules: { ...js.configs.recommended.rules, 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } }]
