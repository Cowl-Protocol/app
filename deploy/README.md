# Cowl app — deploy to the relayer VPS

The app is a **static export** (`output: 'export'` → `out/`). It ships as plain
files served by the same Caddy that already fronts `relay.cowlprotocol.com`, so it
needs **no Node process** on the VPS and never competes with the relayer.

`app.cowlprotocol.com` → VPS `52.0.240.86` (DNS A record already set) → Caddy TLS →
static files under `/var/www/app.cowlprotocol.com`.

## Paths

| Path | What |
|---|---|
| `/var/www/app.cowlprotocol.com` | web root — the exported `out/` lands here |
| `/etc/caddy/Caddyfile` | add the `app.cowlprotocol.com` block (keep the relay block) |

## 1. One-time VPS setup

```bash
# web root
sudo mkdir -p /var/www/app.cowlprotocol.com
sudo chown -R "$USER":"$USER" /var/www/app.cowlprotocol.com

# add the app block to Caddy (do NOT overwrite the relay block)
sudo sh -c 'cat >> /etc/caddy/Caddyfile' < deploy/Caddyfile.app   # or paste it in by hand
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy will fetch a Let's Encrypt cert for `app.cowlprotocol.com` automatically once
DNS resolves and ports 80/443 are reachable.

## 2. Deploy (every release)

From the `app/` directory on a machine with SSH access to the VPS:

```bash
./deploy/deploy.sh root@52.0.240.86
```

That builds `out/`, `rsync`s it to the web root, and reloads Caddy. Or do it by hand:

```bash
npm run build
rsync -az --delete out/ root@52.0.240.86:/var/www/app.cowlprotocol.com/
ssh root@52.0.240.86 'sudo systemctl reload caddy'
```

## Notes

- The build embeds `NEXT_PUBLIC_WC_PROJECT_ID` from `.env.local` (WalletConnect id).
  Keep `.env.local` present on the build machine; it is gitignored.
- Nothing here runs as a service — updating the site is just re-syncing files, so a
  bad deploy can't take the relayer down. `--delete` keeps the web root a clean mirror
  of `out/`.
