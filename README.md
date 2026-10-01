# Poll Kilat

One-question polls with one-tap voting and live results, built for Homeroom.

- **Poll list** (`/`) — every open poll as a card: question, options, vote
  counts and animated live bars for the current tally.
- **Poll detail** (`/poll/:id`) — tap an option to vote (one vote per person
  per poll); results with percentages and bars appear instantly and refresh
  live while the screen is open.
- **Create a poll** (`/new`) — a question (3-280 characters) and 2-4 options.

## How it works

- **Sign-in** — the server verifies the platform-issued user token (an RS256
  JWT) on every request, so the app always knows who is voting. No accounts
  to build.
- **Database** — the app's own Postgres database holds three tables:
  `polls`, `poll_options` and `poll_votes` (one vote per user per poll is
  enforced by a `UNIQUE (poll_id, user_id)` constraint). All three are
  public: poll content and tallies are what every user of the app already
  sees in the UI.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation with either Kubernetes/Paketo or standalone Docker.

## Development

```sh
npm ci --include=dev
npm run build   # compiles styles/tailwind-input.css to public/tailwind.css
npm start
```

Staging previews boot with three "Staging demo" polls (seeded from
`server.js`, fake identities only) so the screens are never empty during
review.