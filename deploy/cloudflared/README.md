# Cloudflare Tunnel — agents.rmind.us

The rack does not expose any port to the public internet. Inbound traffic
arrives over Cloudflare Tunnel and is forwarded to the Next.js container on
port 3000.

## One-time setup

```bash
# on the rack
sudo apt install cloudflared           # or use the docker image directly
cloudflared tunnel login                # opens browser, picks the rmind.us zone
cloudflared tunnel create rmind-agents
cloudflared tunnel route dns rmind-agents agents.rmind.us
cloudflared tunnel token rmind-agents   # paste into rack/.env as CLOUDFLARE_TUNNEL_TOKEN
```

The tunnel token gets baked into the docker-compose service so the rack can
recreate the tunnel automatically on boot.

## Streaming considerations

Cloudflare's edge enforces a 100-second idle timeout on tunneled connections.
The agent runner mitigates this by:

1. Emitting a `{"type":"heartbeat"}` UIMessageChunk every 30 seconds during a
   long quiet phase. The browser ignores it; the connection stays warm.
2. The Next.js streaming endpoint sets `Cache-Control: no-store` and uses a
   `Transfer-Encoding: chunked` SSE response.

If a stream still times out under heavy load, increase the `keepAliveTimeout`
in `config.template.yml` and restart cloudflared.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| 502 from Cloudflare | rack web container not running; check `docker compose ps` |
| 522 timeout | tunnel token mismatched; regenerate with `cloudflared tunnel token` |
| Stream cuts at ~100s | Heartbeat not reaching browser; check `AGENT_BACKEND=pi` |
| "tunnel not found" | DNS route absent; run `cloudflared tunnel route dns rmind-agents agents.rmind.us` |
