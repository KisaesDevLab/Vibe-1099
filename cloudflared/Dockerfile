# Thin wrapper around cloudflared: the official image is DISTROLESS (no shell), but
# the appliance manages the tunnel token in-app by writing it to a shared volume,
# which needs a shell to wait-for + read the token file before exec'ing cloudflared.
# We layer the cloudflared binary onto alpine (has /bin/sh + ca-certificates).
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=cloudflare/cloudflared:latest /usr/local/bin/cloudflared /usr/local/bin/cloudflared
ENTRYPOINT ["/bin/sh", "-c"]
