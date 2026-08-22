FROM alpine:3.20

# nixre-ssh — SSH git transport for sovereign Nixre.
# sshd authenticates users against core's public_keys (AuthorizedKeysCommand)
# and restrictes every session to git-shell (ForcedCommand), which only allows
# git-upload-pack / git-receive-pack / git-upload-archive on repos the user
# may access (checked per-repo by the nixre-git-shell wrapper).

RUN apk add --no-cache openssh git curl

# Shared-volume repos are written by nixre-core (same uid) — trust them all.
RUN git config --system --add safe.directory '*'

# Host keys are generated at boot (persisted via volume on /etc/ssh/keys).
RUN mkdir -p /etc/ssh/keys /data/repos /srv
COPY sshd_config /etc/ssh/sshd_config
COPY nixre-git-shell /srv/nixre-git-shell
COPY ssh-authorized-keys /srv/ssh-authorized-keys
COPY entrypoint.sh /srv/entrypoint.sh
RUN chmod 755 /srv/nixre-git-shell /srv/ssh-authorized-keys /srv/entrypoint.sh \
    && adduser -D -u 1000 -s /bin/sh git \
    && passwd -u git 2>/dev/null || sed -i 's/^git:!/git:*/' /etc/shadow || true

EXPOSE 3022

ENTRYPOINT ["/srv/entrypoint.sh"]
