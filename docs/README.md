# ScreenCapture Docs Site

This package builds the ScreenCapture documentation site with Astro Starlight and deploys the static output to Cloudflare Workers assets through Wrangler.

## Commands

Run these from the `resources/screencapture` root:

```cmd
pnpm dev:docs
pnpm build:docs
pnpm deploy:docs
```

Or work directly inside this package:

```cmd
pnpm --filter @screencapture/docs dev
pnpm --filter @screencapture/docs build
pnpm --filter @screencapture/docs deploy
```

`wrangler.jsonc` deploys `dist/` as Cloudflare Workers static assets with custom 404 handling enabled.