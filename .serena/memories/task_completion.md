# Task completion

- Required automated check for every code change: run `npm run build` and require exit code 0.
- No test, lint, format, or type-check scripts exist; do not claim those checks passed.
- For UI/reader changes, run `npm run dev` and smoke the affected route at desktop and narrow/mobile width. Reader changes should cover opening/closing, forward/back turns, resize/reflow, and sample boundary when relevant.
- For checkout changes, verify both no-key local fallback and real Stripe behavior when credentials are available. Webhook changes require `stripe listen --forward-to localhost:5173/api/stripe-webhook` and a test event; never infer fulfillment from the success page.
- For persistence/auth/delivery changes, verify server authorization independently of client `localStorage` placeholders.
- If Serena memories were changed, run `serena memories check` from the project root.