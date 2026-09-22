# @epistery/cli

The `epistery` command: a device's rivet on the command line. It signs requests
with the device's own key, and it serves an epistery.com session's tools locally,
as a member of that session.

```bash
npm install -g @epistery/cli
```

This package is the command; the [`epistery`](https://github.com/rootz-global/epistery)
package is the identity layer it uses (and the middleware servers attach). Wallet
keys live in `~/.epistery/{domain}/config.ini`, cleartext and owner-only — see
`epistery permissions`.

## A session, as its own member

A rivet granted into a session by address contributes as itself. Pointed at the
session, `epistery mcp` runs that session's own tools on the device: it derives
the session key from the rivet's own leaf, decrypts what it reads and seals what
it writes before anything leaves the device, and asks for its key the way a
browser device does if it has none yet.

```bash
claude mcp add --transport stdio <owner>-<session> -- \
  epistery mcp https://epistery.com/p/wiki/<owner>/<session>
```

Any other URL is bridged to that host's `/mcp` with bot auth, as before.

## Quick Start

```bash
# Check that ~/.epistery is owner-only (keys are cleartext there)
epistery permissions

# See which chains are available (* marks the default for new wallets)
epistery chains

# Initialize a domain (creates wallet in ~/.epistery/{domain}/)
epistery initialize --chain polygon localhost

# Set as default
epistery set-default localhost

# Make authenticated requests
epistery curl https://wiki.rootz.global/wiki/Home
```

## Commands

### `epistery initialize [-c <chain>] <domain>`

Initialize a domain with a new wallet. Creates `~/.epistery/{domain}/config.ini` with:
- Wallet (address, keys, mnemonic)
- Provider configuration for the selected chain

**Options:**
- `-c, --chain <id|name>` - Chain this wallet transacts on: a chainId (`137`),
  an alias (`polygon`), or a full name (`"Polygon Mainnet"`). Run
  `epistery chains` for the list.

Without `--chain`, an interactive terminal prompts for the chain (Enter takes
the default); non-interactive runs (scripts, CI) silently use the default chain.

```bash
epistery initialize localhost                        # prompts, defaults to the configured chain
epistery initialize --chain polygon wiki.rootz.global
epistery initialize -c 81 joc.example.com
```

The chain is written to the domain's `[provider]` block. To move an existing
domain later, use `epistery set-chain` — the wallet is kept.

### `epistery chains`

List the supported chains with their chainIds and aliases. `*` marks the chain
new wallets get when `--chain` isn't given.

```bash
epistery chains
```

### `epistery set-chain <domain> <chain>`

Point an already-initialized domain at a different chain. Only the domain's
`[provider]` block is rewritten — the wallet, and therefore the address, is
chain-agnostic and is kept as-is.

```bash
epistery set-chain wiki.rootz.global polygon
epistery set-chain localhost 80002
```

The same address exists on the new chain, but nothing moves with it: balances,
deployed contracts and whitelist entries stay on the old chain, and the wallet
starts unfunded on the new one.

### `epistery set-default-chain <chain>`

Set the chain used for new wallets, in `~/.epistery/config.ini`
(`[default] defaultChainId` plus the matching `[default.provider]` block).
Existing wallets are unaffected.

```bash
epistery set-default-chain polygon
epistery set-default-chain 137
```

### `epistery curl [options] <url>`

Make authenticated HTTP requests using bot authentication (signs each request with wallet).

**Options:**
- `-w, --wallet <domain>` - Use specific domain wallet (overrides default)
- `-X, --request <method>` - HTTP method (default: GET)
- `-d, --data <data>` - Request body: a quoted JSON string, or `@path` to read the body from a file
- `-H, --header <header>` - Additional headers
- `-v, --verbose` - Show detailed output

**Examples:**
```bash
# GET request (uses default domain)
epistery curl https://wiki.rootz.global/wiki/Home

# Use specific domain wallet
epistery curl -w localhost https://localhost:4080/wiki/Home

# PUT request with JSON data (note single quotes around JSON)
epistery curl -X PUT -d '{"title":"Test","body":"# Test"}' https://wiki.rootz.global/wiki/Test

# PUT a large or multi-line body from a file. Bot auth signs a hash of the body,
# so the file is read here and sent verbatim — the sent bytes match what was
# signed. Prefer this over inline -d for anything big or with awkward quoting.
epistery curl -X PUT -d @page.json https://wiki.rootz.global/wiki/Test

# POST request
epistery curl -X POST -d '{"name":"value"}' https://api.example.com/endpoint

# Verbose output for debugging
epistery curl -v https://wiki.rootz.global/wiki/Home
```

**Important Notes:**
- Always use **single quotes** around JSON data to prevent shell interpretation
- The CLI uses bot authentication mode (signs each request individually)
- No session management - each request is independently authenticated

### `epistery info [domain]`

Show domain information (wallet address, provider, session status).

```bash
epistery info                # Show default domain
epistery info localhost      # Show specific domain
```

### `epistery set-default <domain>`

Set default domain for CLI operations.

```bash
epistery set-default localhost
```

## Architecture

### Domain-Based Configuration

Epistery CLI uses the same domain configuration system as the server:

```
~/.epistery/
├── config.ini                    # Root config with [cli] and [default] sections
│   ├── [cli]
│   │   └── default_domain=localhost
│   └── [default]
│       └── defaultChainId=137    # chain new wallets get (epistery set-default-chain)
├── localhost/
│   └── config.ini                # Domain config with wallet & provider
└── wiki.rootz.global/
    └── config.ini
```

Wallet mnemonics and private keys are stored in cleartext, so the whole tree is
owner-only: directories `0700`, files `0600`. Epistery creates them that way and
repairs a too-open file when it writes it; `epistery permissions` checks what is
already on disk.

### `epistery permissions [--fix]`

Audit the modes of everything under `~/.epistery`. The tree holds wallet
mnemonics and private keys in cleartext, so anything readable by group or other
is a finding; the command exits `1` when it finds something.

```bash
epistery permissions          # report
epistery permissions --fix    # chmod files to 0600, directories to 0700
```

New installs are created owner-only and each write tightens the file it touches,
so this is mainly for trees created before that rule (`config.ini` at `0664` is
the common case) — the new-machine check that prompted it.

Note that `--fix` walks the *whole* tree, including files other tools put there.
If a local service running as another user legitimately reads something from
`~/.epistery` (a TLS key, say), give it access deliberately — group ownership on
that one path — rather than leaving the tree world-readable.

### Authentication

The CLI uses **bot authentication mode**, which signs each request individually with the domain wallet's private key:

1. Load domain wallet from `~/.epistery/{domain}/config.ini`
2. Build the canonical bot-auth message for **this request** — method, URI,
   audience host, SHA-256 of the body, timestamp, single-use nonce
   (`client/bot-auth-message.mjs`, the one definition both signer and verifier use)
3. Sign those bytes with the wallet's private key
4. Send the envelope in `Authorization: Bot <base64-encoded-json>` header
5. Server rebuilds the same bytes from the request it actually received and
   verifies the signature, freshness, audience, and nonce

**Benefits:**
- Stateless - no session management needed
- Secure - private keys never leave your machine
- Simple - works immediately after initialization
- Bound - the signature authorises *that* request. A captured header cannot be
  replayed, retargeted at another endpoint or host, or reused with a different body.

**Note for host applications:** nothing to do. `epistery.attach(app)` captures the
raw request bytes its signatures commit to — but only for requests that carry an
`Authorization: Bot` header, so a bot request with a body just works while all
other traffic (uploads, streams, your own parser and its size limit) is left
completely untouched. The one optional knob is the bot body-size limit, default
100mb:

```js
await epistery.attach(app, undefined, { bodyLimit: '250mb' });
```

`captureRawBody` is still exported for the one case that is not a host: a server
that verifies epistery-signed data **without** installing epistery (e.g. a relay
running its own storage-message check). There you wire the hook into your own
parser by hand — `app.use(express.json({ verify: captureRawBody }))`.

## Usage Patterns

### Local Development

```bash
# Initialize for local development
epistery initialize localhost
epistery set-default localhost

# Make requests
epistery curl https://localhost:4080/wiki/index
epistery curl -X PUT -d '{"title":"Test","body":"# Test"}' https://localhost:4080/wiki/Test
```

### Multiple Domains

```bash
# Initialize multiple domains
epistery initialize localhost
epistery initialize wiki.rootz.global
epistery initialize staging.example.com

# Switch between them
epistery curl -w localhost https://localhost:4080/...
epistery curl -w wiki.rootz.global https://wiki.rootz.global/...
epistery curl -w staging.example.com https://staging.example.com/...

# Or set default and omit -w
epistery set-default wiki.rootz.global
epistery curl https://wiki.rootz.global/...
```

### Bot/Agent Applications

```javascript
import { CliWallet } from 'epistery';

// Load domain wallet
const wallet = CliWallet.load('localhost');  // or CliWallet.load() for default

// Create bot auth header
const authHeader = await wallet.createBotAuthHeader();

// Make request
const response = await fetch('https://localhost:4080/wiki/Home', {
  headers: { 'Authorization': authHeader }
});
```

## Configuration Files

### Root Config (`~/.epistery/config.ini`)

```ini
[profile]
name=
email=

[ipfs]
url=https://rootz.digital/api/v0

[default.provider]
chainId=1
name=Ethereum Mainnet
rpc=https://eth.llamarpc.com
nativeCurrencyName=Ether
nativeCurrencySymbol=ETH
nativeCurrencyDecimals=18

[cli]
default_domain=localhost
```

### Domain Config (`~/.epistery/{domain}/config.ini`)

```ini
[domain]
domain=localhost

[wallet]
address=0x...
mnemonic=word word word...
publicKey=0x04...
privateKey=0x...

[provider]
chainId=137
name=Polygon Mainnet
rpc=https://polygon-rpc.com
nativeCurrencyName=POL
nativeCurrencySymbol=POL
nativeCurrencyDecimals=18
```

## Supported Chains

Epistery supports multiple blockchain networks. Configure your domain's provider to use any of these chains:

### Ethereum Mainnet
```ini
[provider]
chainId=1
name=Ethereum Mainnet
rpc=https://eth.llamarpc.com
nativeCurrencyName=Ether
nativeCurrencySymbol=ETH
nativeCurrencyDecimals=18
```

### Polygon Mainnet (POL)
```ini
[provider]
chainId=137
name=Polygon Mainnet
rpc=https://polygon-rpc.com
nativeCurrencyName=POL
nativeCurrencySymbol=POL
nativeCurrencyDecimals=18
```

### Japan Open Chain (JOC)
```ini
[provider]
chainId=81
name=Japan Open Chain
rpc=https://rpc-2.japanopenchain.org:8545
nativeCurrencyName=Japan Open Chain Token
nativeCurrencySymbol=JOC
nativeCurrencyDecimals=18
```

To move a domain to a different chain, use `epistery set-chain <domain> <chain>`
(it rewrites that `[provider]` section and keeps the wallet).

## Security

- Domain configs stored with 0600 permissions, their directories 0700 (owner
  only). Keys are cleartext on disk, so this is the only thing between them and
  another local account — verify with `epistery permissions`
- Private keys never transmitted (only signatures)
- Each domain has its own isolated wallet
- Each request is signed with fresh timestamp to prevent replay attacks

## Design Philosophy

The Epistery CLI uses a unified command structure with subcommands:
- ✅ Uses existing Epistery domain config system
- ✅ Consistent with server-side architecture
- ✅ Bot authentication (stateless, no session management)
- ✅ Default domain support (less typing)
- ✅ Simpler mental model (domain = wallet)

## Examples

### Initialize and Use

```bash
# Setup
epistery initialize localhost
epistery set-default localhost

# Use
epistery curl https://wiki.rootz.global/wiki/Home
epistery curl https://wiki.rootz.global/wiki/index
```

### Multiple Domains

```bash
# Setup each environment
epistery initialize dev.example.com
epistery initialize staging.example.com
epistery initialize prod.example.com

# Use different environments
epistery curl -w dev.example.com https://dev.example.com/api/status
epistery curl -w staging.example.com https://staging.example.com/api/status
epistery curl -w prod.example.com https://prod.example.com/api/status
```

## Troubleshooting

**"Domain not found or has no wallet"**
- Run `epistery initialize <domain>` first

**401 Unauthorized errors**
- Server may not recognize your wallet address
- Check that your address is authorized on the server
- Use `-v` flag for detailed debugging output

**JSON parsing errors**
- Ensure JSON data is wrapped in **single quotes**: `'{"key":"value"}'`
- Check that JSON is valid (use a JSON validator if needed)

## Integration

The CLI is designed to work with:
- **Rhonda** - Wiki with Epistery authentication
- **Any Epistery-enabled app** - Just initialize and curl!

Server-side apps should implement bot authentication handler (see Rhonda's account-server for example).