# Cowl app — static site block for the relayer VPS's Caddy.
#
# APPEND this block to the existing /etc/caddy/Caddyfile (the one that already
# serves relay.cowlprotocol.com). Do NOT replace that file — keep the relay block.
# Caddy provisions and renews a Let's Encrypt cert for app.cowlprotocol.com on its
# own, as long as the DNS A record points at this VPS and ports 80/443 are open.

app.cowlprotocol.com {
	root * /var/www/app.cowlprotocol.com
	encode gzip zstd
	file_server

	# Next.js static export: serve the built HTML, fall back sensibly for deep links.
	try_files {path} {path}.html {path}/index.html /index.html

	# Static assets are content-hashed under /_next/ — cache them hard.
	@immutable path /_next/static/*
	header @immutable Cache-Control "public, max-age=31536000, immutable"
}
