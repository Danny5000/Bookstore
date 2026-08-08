# Suggested commands (PowerShell, project root)

- Install: `npm install`.
- Create local env file: `Copy-Item .env.example .env`, then replace placeholder secrets locally; `.env` is ignored.
- Development server: `npm run dev` (Vite/SvelteKit; default URL normally `http://localhost:5173`).
- Production build: `npm run build`.
- Preview production build: `npm run preview`.
- Stripe webhook forwarding when testing real Stripe: `stripe listen --forward-to localhost:5173/api/stripe-webhook`.
- Check Serena memory references after memory edits: `serena memories check`.
- Useful Windows listings: `Get-ChildItem -Force`; project file search: `rg --files`; text search: `rg -n 'pattern' src`.
- There are currently no npm scripts for test, lint, format, or static type checking.