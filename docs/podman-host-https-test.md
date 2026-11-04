# Host broker HTTPS for separate Podman sandboxes: connectivity first

This optional operator procedure is not part of automated testing. Its existing local image name can be built with `podman build --target runtime -f Containerfile -t localhost/ai-agent-msg-broker-test:reviewed .`; the name is only a local compatibility alias, not a test image stage.

A container's `127.0.0.1` is not the host. The broker's insecure-development HTTP
mode intentionally cannot be exposed beyond loopback. This helper starts **only
the host HTTPS broker**; it does not launch/configure clients or change existing
containers, routing, firewall rules, global trust stores, or session lifetimes.

## 1. Select the host listener explicitly

Update the implementation branch without overwriting local changes. Use a normal
nonroot Linux account, the existing reviewed local image and existing OpenSSL:

```sh
git status --short
git pull --ff-only
bash scripts/start-lan-broker.sh \
  --bind HOST_LAN_IPV4 \
  --hostname host.containers.internal \
  --port 8787
```

Replace `HOST_LAN_IPV4` with an IPv4 address **actually assigned to the host**.
The script checks that; it will not bind a guessed container gateway. The
hostname is the exact name clients will use and is included in the certificate's
SAN. It does not create DNS entries or assert control over a DNS name. An actual
reachable host IP can also be the `--hostname`, producing an IP SAN.

If you deliberately want all host IPv4 interfaces instead of one selected
interface, this explicit alternative is available:

```sh
bash scripts/start-lan-broker.sh \
  --bind 0.0.0.0 --allow-all-interfaces \
  --hostname host.containers.internal --port 8787
```

**Exposure:** the second command opens the TLS listener on every reachable host
IPv4 interface, potentially including LAN/public interfaces. Prefer one private
interface when possible; run the wildcard alternative only if that exposure is
intended. Authentication remains required for every `/v1` endpoint. Public
`/healthz` and `/readyz` return only minimal status. No firewall opening, public
tunnel, port-forward rule, privileged container or host-network container is
created. Do not disable a firewall to make a failed connection pass.

The helper reuses a hash/version-checked isolated Node 24.19.0 copied from the
already local image: no global Node upgrade or image rebuild is needed. It prints
progress and bounds runtime preparation/OpenSSL commands. New files are private
and outside the checkout. Each invocation creates a fresh private CA and a
serverAuth certificate valid for one day; the CA signing key is then removed.
The broker and its two distinct test credentials stop/expire after **two hours**.
No production certificate or ongoing access is provisioned.

## 2. Make only the public CA available for the first test

The terminal prints:

```text
BROKER_URL=https://host.containers.internal:8787
PUBLIC_CA_FILE=<private-lab>/state/connectivity/ca.crt
CA_SHA256=<public-certificate-file-sha256>
CLIENT-A bundle directory: <private-lab>/state/client-a
CLIENT-B bundle directory: <private-lab>/state/client-b
```

For connectivity testing, make **only the public `connectivity/ca.crt` file**
available inside each sandbox using your normal controlled file-sharing/mount
mechanism. The printed host path is not automatically a container path. Choose
the path visible inside the sandbox, and compare its SHA256 with the printed
fingerprint. A copied CA is public, but its authenticity matters. Do not mount
`server-private`, the whole lab directory, a home directory or any token at this
stage. No OS-wide CA installation is needed: configure trust per request/client.

Keep the broker terminal open. Existing sandboxes/clients are not changed by this
script. Their network must already provide a route to the selected host address.

## 3. Prompt for a fresh sandbox session

Replace the three placeholders with the printed URL, the **container-visible**
public CA path and the printed CA fingerprint. This prompt requires no token:

> Test connectivity only to `BROKER_HTTPS_URL`, using the public CA file at
> `CONTAINER_CA_FILE` with SHA256 `CA_SHA256`. Do not inspect tokens, configure
> plugins, install anything, restart sessions, change networking/firewalls/global
> CA trust, or disable certificate/hostname verification. Do not use `-k`,
> `--insecure`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, redirects or automatic retries.
>
> With tools already available, verify the CA file fingerprint and resolve the
> URL's hostname. Then make unauthenticated HTTPS GET requests to `/healthz`,
> `/readyz` and `/v1/clients`, using that CA for these requests. Use a
> 3-second connection timeout, 10-second total timeout and at most 4 KiB output
> per request (for example, curl with `--cacert`, `--connect-timeout 3`,
> `--max-time 10`, `--max-filesize 4096`). Do not read or send any bearer token.
>
> Expected results: verified TLS; `/healthz` HTTP 200 with `status: ok`;
> `/readyz` HTTP 200 with `status: ready`; `/v1/clients` HTTP 401 because no
> credential was supplied. Report a short DNS/TCP/TLS/HTTP result table and bounded
> error/exit codes. Stop on a failure and report it without trying to repair or
> bypass anything. Do not begin plugin configuration yet.

A TLS error is not an authentication failure. A DNS failure, connection refusal or
timeout must be diagnosed separately. HTTP 401 on the unauthenticated API check
is **success for this stage**, not a reason to weaken authentication.

## Podman routes are version/backend dependent

The official [current Podman run reference](https://docs.podman.io/en/latest/markdown/podman-run.1.html)
describes `host.containers.internal` and its conditional host-gateway mapping.
Current pasta integration maps a virtual guest address (normally `169.254.1.2`)
for host access; that address is **not necessarily assigned to the host** and
must not be guessed as its bind. Older
[slirp4netns integration](https://docs.podman.io/en/v4.4/markdown/podman-run.1.html)
has separate host-loopback behavior, disabled by default. Host aliases may also
be absent or customized. A wildcard listener does not fix DNS, routing or a
firewall. This helper never switches backends or enables host-loopback access.

Current CI is unit-only and does not exercise this route. Review the selected backend, host alias and assigned interface directly when using this operator helper. A failed real route needs review before any bounded network/firewall change is proposed.

## Later: client configuration, not part of the first prompt

Each client bundle contains exactly `connection.json`, `token` and `ca.crt`.
Never give client A client B's bundle, and never share the server key. The JSON
has the v1 `broker_url`, `protocol_version: "1"`, `token_file: "token"`,
`ca_file: "ca.crt"`, `file_paths_relative_to: "connection_file_directory"`,
Bearer authorization, `insecure_development: false`, allowed types, scope and
expiry. Resolve relative paths **inside that container**, not on the host.

For example, if one bundle is made available read-only at `/run/broker-client`,
the shared reference client transport options are:

```js
{ url: 'https://host.containers.internal:8787',
  tokenFile: '/run/broker-client/token', caFile: '/run/broker-client/ca.crt',
  insecureDevelopment: false }
```

The connector still owns its durable inbox and actual session registration. This
is not an assumed installed-plugin configuration API; HTTPS reachability does not
solve native attachment or plugin lifecycle. Keep tokens out of prompts, tool
arguments, logs and chat. Files must remain readable only through the intended
UID mapping; never loosen secret permissions as a workaround. If SELinux relabel
or another mount change is needed, review that separate action first.

Two-hour expiry is not silently renewed. A new invocation creates a new CA,
credentials and broker state; update the intended clients through their own
configuration mechanism only when ready. Delivery still means durable adapter
inbox, not native/model reading.

## Stop and cleanup

Ctrl+C in the broker terminal stops only this HTTPS listener. The private lab
files remain for inspection; no service/autostart was installed. After stopping
use of this lab and any mounts, inspect and remove only the printed disposable
directory:

```sh
lab='/exact/printed/broker-lan-test.XXXXXXXX'
test -f "$lab/state/LAN-BROKER.json" && ls -ld -- "$lab"
# After checking this exact path and ending use of its files:
test -f "$lab/state/LAN-BROKER.json" && rm -r -- "$lab"
```

Partial failed preparation may leave only its newly created private directory;
inspect before deleting it. Certificate generation uses the official
[OpenSSL request](https://docs.openssl.org/3.0/man1/openssl-req/) and
[certificate signing](https://docs.openssl.org/3.0/man1/openssl-x509/) interfaces;
strict DNS/IP validation prevents configuration syntax from entering the SAN.
