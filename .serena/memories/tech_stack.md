# Tech stack

- Node/npm project with committed `package-lock.json`; package is private ESM (`"type": "module"`).
- SvelteKit `^2.8.0`, Svelte `^5.1.9`, Vite `^5.4.10`, `@sveltejs/adapter-auto` `^3.3.1`.
- Stripe server SDK `^17.3.0`; Stripe webhook CLI is optional for local payment testing.
- JavaScript, not TypeScript. `jsconfig.json`: bundler resolution, ESNext module/target, `allowJs: true`, `checkJs: false`, `strict: false`; `$lib` comes from SvelteKit.
- Styling is plain CSS: global tokens/primitives in `src/app.css`, scoped CSS in components.
- Serena project uses the `svelte` language server, UTF-8, workspace root `.`; dependencies must be installed for language tooling.