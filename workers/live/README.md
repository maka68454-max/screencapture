# Screencapture Live Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/itschip/screencapture/tree/main/workers/live)

This Worker coordinates screencapture WebRTC sessions through Cloudflare Realtime SFU. The deployment flow prompts for your Realtime App ID and App Secret, then automatically creates and binds the SQLite `LiveStreamRoom` Durable Object.

After deployment, copy the Worker URL into your FiveM `server.cfg`:

```cfg
set screencapture_live_endpoint "https://screencapture-live.<account>.workers.dev"
```

You must create the Realtime SFU app separately in the Cloudflare dashboard. Do not commit `.dev.vars` or expose the Realtime App Secret to FiveM clients.