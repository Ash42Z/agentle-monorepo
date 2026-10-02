FROM caddy:2.10.2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY web/index.html /srv/index.html
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
