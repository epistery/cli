#!/usr/bin/env node

/**
 * epistery - Unified CLI tool for Epistery
 *
 * Usage:
 *   epistery initialize <domain>         Initialize domain with wallet
 *   epistery chains                      List supported chains
 *   epistery set-chain <domain> <chain>  Move a domain to another chain
 *   epistery permissions [--fix]         Audit/repair ~/.epistery file modes
 *   epistery set-default-chain <chain>   Set chain used for new wallets
 *   epistery curl [options] <url>        Make authenticated HTTP request
 *   epistery mcp [options] <url>         Stdio MCP bridge with bot-auth
 *   epistery info [domain]               Show version and domain information
 *   epistery set-default <domain>        Set default domain for CLI
 *
 * The curl subcommand automatically performs key exchange when needed.
 */

import {
  CliWallet,
  Config,
  auditTree,
  formatMode,
  secureTree,
  configuredChains,
  defaultChain,
  findChain,
  providerConfigFor,
  setDefaultChain,
} from "epistery";
import { ethers } from "ethers";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The version this CLI reports is whatever its own package.json declares — read
// here, never written down, so `epistery info` cannot claim a version other than
// the one actually installed.
const VERSION = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")).version;

// Load .env file from project root
// quiet: dotenv 17 prints a banner to STDOUT, which corrupts `epistery mcp`'s
// JSON-RPC stream (stdout is the protocol channel there).
dotenv.config({ path: join(__dirname, ".env"), quiet: true });

/**
 * Extract global options from args (like -p/--port)
 * Returns { options, remainingArgs }
 */
function extractGlobalOptions(args) {
  const options = {
    port: null,
  };
  const remainingArgs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-p" || arg === "--port") {
      options.port = args[++i];
    } else {
      remainingArgs.push(arg);
    }
  }

  return { options, remainingArgs };
}

/**
 * Extract the -c/--chain option from initialize args.
 * Returns { chain, remainingArgs }
 */
function extractChainOption(args) {
  let chain = null;
  const remainingArgs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c" || arg === "--chain") {
      chain = args[++i];
      if (!chain) {
        console.error("Error: --chain requires a chainId or name");
        process.exit(1);
      }
    } else {
      remainingArgs.push(arg);
    }
  }

  return { chain, remainingArgs };
}

/**
 * Format error message with helpful suggestions
 * @param {Error} error - The error object
 * @param {string} domain - The domain being connected to
 * @param {string|null} port - The port (if specified)
 * @returns {string} Formatted error message with suggestions
 */
function formatNetworkError(error, domain, port) {
  const message = error.message || String(error);
  const cause = error.cause;

  // Check for common network error codes
  const errorCode = cause?.code || error.code;

  let hint = "";

  if (errorCode === "ECONNREFUSED" || message.includes("ECONNREFUSED")) {
    hint = "\n\nThe server refused the connection.";
    if (domain === "localhost" && !port) {
      hint += "\n→ If your server is running on a different port, use: -p <port>";
      hint += "\n  Example: epistery info localhost";
    } else {
      hint += "\n→ Make sure the server is running";
      if (port) {
        hint += ` on port ${port}`;
      }
    }
  } else if (errorCode === "ETIMEDOUT" || message.includes("ETIMEDOUT")) {
    hint = "\n\nThe connection timed out.";
    hint += "\n→ Check if the server is accessible";
    hint += "\n→ Check your network connection";
  } else if (errorCode === "ENOTFOUND" || message.includes("ENOTFOUND")) {
    hint = "\n\nCould not resolve the hostname.";
    hint += `\n→ Check that "${domain}" is a valid domain`;
    hint += "\n→ Check your DNS settings or network connection";
  } else if (errorCode === "ECONNRESET" || message.includes("ECONNRESET")) {
    hint = "\n\nThe connection was reset by the server.";
    hint += "\n→ The server may have crashed or restarted";
    hint += "\n→ Try again in a moment";
  } else if (message.includes("failed, reason:")) {
    // Generic fetch failure with empty reason
    hint = "\n\nCould not connect to the server.";
    if (domain === "localhost" && !port) {
      hint += "\n→ If your server is running on a different port, use: -p <port>";
      hint += "\n  Example: epistery info localhost";
    } else {
      hint += "\n→ Make sure the server is running and accessible";
    }
  }

  return message + hint;
}

function showHelp() {
  console.log("epistery - CLI tool for Epistery authentication and requests");
  console.log("");
  console.log("Usage:");
  console.log(
    "  epistery initialize [-c chain] <domain>   Initialize domain with wallet",
  );
  console.log(
    "  epistery mcp [-w domain] <url>            Stdio MCP bridge with bot-auth",
  );
  console.log(
    "  epistery curl [options] <url>             Make authenticated HTTP request",
  );
  console.log(
    "  epistery info [domain]                    Show version and domain information",
  );
  console.log(
    "  epistery set-default <domain>             Set default domain for CLI",
  );
  console.log(
    "  epistery chains                           List supported chains",
  );
  console.log(
    "  epistery set-default-chain <chain>        Set chain used for new wallets",
  );
  console.log(
    "  epistery set-chain <domain> <chain>       Move a domain to another chain",
  );
  console.log(
    "  epistery permissions [--fix]              Audit (or repair) key file modes",
  );
  console.log("");
  console.log("initialize options:");
  console.log(
    "  -c, --chain <id|name>    Chain for this wallet (e.g. 137 or polygon).",
  );
  console.log(
    "                           Omitted: prompts, or uses the default chain",
  );
  console.log(
    "                           when not on a terminal. See: epistery chains",
  );
  console.log("");
  console.log("Global Options:");
  console.log(
    "  -p, --port <port>        Server port (for localhost development)",
  );
  console.log("");
  console.log("mcp options:");
  console.log(
    "  -w, --wallet <domain>    Use specific domain wallet (overrides default)",
  );
  console.log("");
  console.log("curl options:");
  console.log(
    "  -w, --wallet <domain>    Use specific domain wallet (overrides default)",
  );
  console.log("  -X, --request <method>   HTTP method (default: GET)");
  console.log("  -d, --data <data>        Request body; use @path to read the body from a file");
  console.log("  -H, --header <header>    Additional headers");
  console.log(
    "  -b, --bot                Use bot auth header (the default)",
  );
  console.log("  -v, --verbose            Show detailed output");
  console.log("");
  console.log("Examples:");
  console.log("  # Initialize a domain (creates wallet)");
  console.log("  epistery initialize localhost");
  console.log("  epistery initialize --chain polygon geist.social");
  console.log("");
  console.log("  # Put every new wallet on Polygon mainnet from here on");
  console.log("  epistery set-default-chain 137");
  console.log("");
  console.log("  # Move an existing domain's wallet to another chain");
  console.log("  epistery set-chain geist.social polygon");
  console.log("");
  console.log("  # MCP bridge (use with Claude Code or any MCP client)");
  console.log("  claude mcp add --transport stdio geist-social -- epistery mcp https://geist.social");
  console.log("  # a console session: served locally, as this rivet (a member, own key)");
  console.log("  claude mcp add --transport stdio my-wiki -- epistery mcp https://epistery.com/p/wiki/<owner>/<session>");
  console.log("");
  console.log("  # Make authenticated requests");
  console.log("  epistery curl https://example.com/api/data");
  console.log('  epistery curl --bot -X POST -d \'{"title":"Test"}\' <url>');
  console.log("  # a large or multi-line body from a file (read and signed intact):");
  console.log("  epistery curl -X POST -d @page.json <url>");
  console.log("");
  console.log("Domain configs stored in: ~/.epistery/{domain}/config.ini");
  console.log("Default domain set in: ~/.epistery/config.ini [cli] section");
  console.log("");
  console.log("Wallet keys are cleartext on disk — files 0600, directories 0700.");
  console.log("Check with: epistery permissions");
}

/**
 * Print the supported chains, marking the one new wallets get by default.
 * Shown by `epistery chains`, and again whenever a chain selector fails.
 */
async function printChains(prefix = "") {
  const chains = await configuredChains();
  let current = null;
  try {
    current = await defaultChain();
  } catch {
    // No default resolvable (unregistered chainId in config) — just list.
  }

  for (const chain of chains) {
    const isDefault = current && Number(current.chainId) === Number(chain.chainId);
    const marker = isDefault ? "*" : " ";
    const id = String(chain.chainId).padEnd(9);
    const alias = (chain.aliases || [])[0];
    const name = alias ? `${chain.name} (${alias})` : chain.name;
    console.log(`${prefix}${marker} ${id} ${name}`);
  }
  console.log(`${prefix}  (* = default for new wallets; use the id or the name in parens)`);
}

/**
 * Resolve a --chain selector, or fail with the list of valid chains.
 */
async function resolveChainOrExit(selector) {
  let chain = null;
  try {
    chain = await findChain(selector);
  } catch (error) {
    // Ambiguous abbreviation
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  if (!chain) {
    console.error(`Error: Unknown chain '${selector}'`);
    console.error("");
    console.error("Supported chains:");
    await printChains("  ");
    process.exit(1);
  }
  return chain;
}

/**
 * Ask which chain to use, defaulting to the configured default. Only called
 * on an interactive terminal; scripts get the default without a prompt.
 */
async function promptForChain() {
  const fallback = await defaultChain();

  console.log("Available chains:");
  await printChains("  ");
  console.log("");

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) =>
    rl.question(`Chain [${fallback.chainId} ${fallback.name}]: `, resolve),
  );
  rl.close();
  console.log("");

  // Answers are chainIds or names, the same selectors --chain takes — no
  // menu numbers, so "1" always means Ethereum mainnet and never "the first
  // row".
  const choice = answer.trim();
  return choice ? await resolveChainOrExit(choice) : fallback;
}

async function listChains() {
  console.log("Supported chains:");
  await printChains("  ");
  console.log("");
  console.log("Use one for a new wallet:  epistery initialize -c <chain> <domain>");
  console.log("Change the default:        epistery set-default-chain <chain>");
}

async function setDefaultChainCommand(selector) {
  const chain = await resolveChainOrExit(selector);
  await setDefaultChain(chain.chainId);
  console.log(`✓ Default chain set to: ${chain.name} (${chain.chainId})`);
  console.log("");
  console.log("New wallets use this chain. Existing wallets keep theirs;");
  console.log("check with: epistery info <domain>");
}

/**
 * Re-point an existing domain at another chain. The wallet is chain-agnostic,
 * so the address survives — only the domain's [provider] block changes.
 */
async function setChainCommand(domain, selector) {
  const chain = await resolveChainOrExit(selector);
  const previous = await CliWallet.setChain(domain, providerConfigFor(chain));

  if (previous && Number(previous.chainId) === Number(chain.chainId)) {
    console.log(`${domain} is already on ${chain.name} (${chain.chainId})`);
    return;
  }

  const wallet = await CliWallet.load(domain);
  console.log(`✓ ${domain} moved to ${chain.name} (${chain.chainId})`);
  if (previous) {
    console.log(`  was: ${previous.name || "unknown"} (${previous.chainId})`);
  }
  console.log("");
  console.log(`Wallet ${wallet.address} is unchanged — the same address on the`);
  console.log("new chain. Balances, contracts and whitelist entries do NOT move;");
  console.log("this wallet starts unfunded on the new chain.");
}

/**
 * Audit — or with --fix, repair — the modes of everything under ~/.epistery.
 * The tree holds wallet mnemonics and private keys in cleartext, so anything
 * readable by group or other is a finding.
 */
async function permissionsCommand(fix) {
  const root = new Config().configDir;

  if (process.platform === "win32") {
    console.log("Windows uses ACLs rather than mode bits — nothing to audit here.");
    console.log(`Check that only your account can read: ${root}`);
    return;
  }

  if (!fix) {
    const findings = await auditTree(root);
    if (findings.length === 0) {
      console.log(`✓ ${root} is owner-only (files 0600, directories 0700)`);
      return;
    }

    console.log(`${findings.length} path(s) under ${root} are readable by other users:`);
    console.log("");
    for (const entry of findings) {
      console.log(
        `  ${formatMode(entry.mode)} → ${formatMode(entry.expected)}  ${entry.type === "dir" ? "dir " : "file"}  ${entry.path}`,
      );
    }
    console.log("");
    console.log("Repair with: epistery permissions --fix");
    process.exitCode = 1;
    return;
  }

  const { fixed, failed } = await secureTree(root);

  if (fixed.length === 0 && failed.length === 0) {
    console.log(`✓ ${root} was already owner-only — nothing to change`);
    return;
  }

  for (const entry of fixed) {
    console.log(`  ${formatMode(entry.mode)} → ${formatMode(entry.expected)}  ${entry.path}`);
  }
  console.log("");
  console.log(`✓ Tightened ${fixed.length} path(s) under ${root}`);

  if (failed.length > 0) {
    console.log("");
    console.log(`Could not change ${failed.length} path(s) — check the owner:`);
    for (const entry of failed) {
      console.log(`  ${formatMode(entry.mode)}  ${entry.path}`);
    }
    process.exitCode = 1;
  }
}

async function initializeDomain(domain, chainSelector) {
  try {
    // Reject domains with colons (ports) - macOS can't handle colons in filenames
    if (domain.includes(':')) {
      console.error('Error: Domain cannot contain a colon (port number).');
      console.error('');
      console.error('The domain should be just the hostname, not hostname:port.');
      console.error('Example: Use "localhost" not "localhost:3001"');
      console.error('');
      console.error('The port is only for network connections - the domain identity');
      console.error('for authentication purposes is just the hostname.');
      process.exit(1);
    }

    // Chain: --chain wins; otherwise ask when we have a terminal, and fall
    // back to the configured default when we don't (scripts, CI).
    let chain;
    if (chainSelector) {
      chain = await resolveChainOrExit(chainSelector);
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      chain = await promptForChain();
    } else {
      chain = await defaultChain();
    }

    console.log(`Initializing domain: ${domain}`);
    console.log(`Chain: ${chain.name} (${chain.chainId})`);
    console.log("");

    const wallet = await CliWallet.initialize(domain, providerConfigFor(chain));

    console.log("");
    console.log("Domain initialized successfully");
    console.log("");

    // Try to add to epistery::admin list automatically
    let addedToAdmin = false;
    try {
      // Load config to get agent contract address
          const config = new Config();
      await config.setPath(`/${domain}`);

      const contractAddress = config.data?.contract_address;

      if (
        contractAddress &&
        contractAddress !== "0x0000000000000000000000000000000000000000"
      ) {
        console.log("Adding wallet to epistery::admin list...");

        // Get the server wallet (which was just initialized)
        const serverWallet = await Utils.InitServerWallet(domain);

        if (serverWallet) {
          await Utils.AddToWhitelist(
            serverWallet,
            "epistery::admin",
            wallet.address,
            "CLI Admin",
            3, // Admin role
            JSON.stringify({
              addedBy: serverWallet.address,
              addedMethod: "cli-initialize",
              timestamp: new Date().toISOString(),
            }),
            contractAddress,
          );
          console.log("Added to epistery::admin list");
          addedToAdmin = true;
        }
      } else {
        console.log("Note: No agent contract configured yet.");
        console.log("      Run server first, then add to admin list manually.");
      }
    } catch (adminError) {
      console.log("");
      console.log("Note: Could not add to epistery::admin list automatically.");
      console.log(`      Reason: ${adminError.message}`);
      console.log("");
      console.log("      Common reasons:");
      console.log("      - Wallet needs funds for gas fees");
      console.log("      - Agent contract not deployed yet");
      console.log("      - Network connectivity issues");
    }

    console.log("");
    console.log(
      "Configuration saved to: ~/.epistery/" + domain + "/config.ini",
    );
    console.log("Wallet address: " + wallet.address);
    console.log("");

    if (!addedToAdmin) {
      console.log(
        "To add as admin manually (after server is running with funds):",
      );
      console.log(
        `  epistery list add ${domain} epistery::admin ${wallet.address} "Admin" admin`,
      );
      console.log("");
    }

    console.log("Set as default with: epistery set-default " + domain);
    console.log("Make requests with: epistery curl https://example.com");
  } catch (error) {
    console.error("");
    console.error("Error:", error.message);
    process.exit(1);
  }
}

async function showInfo(domain) {
  try {
    const wallet = await CliWallet.load(domain);

    console.log("Version:", VERSION);
    console.log("");
    console.log("Domain:", wallet.getDomain());
    console.log("Address:", wallet.address);
    console.log("Public Key:", wallet.publicKey);
    console.log("");

    const provider = wallet.getProvider();
    if (provider) {
      console.log("Provider:", provider.name);
      console.log("Chain ID:", provider.chainId);
      console.log("RPC:", provider.rpc);
      console.log("");
    }

    console.log(
      "Sessions: Stored per-server in ~/.epistery/" +
        wallet.getDomain() +
        "/sessions/",
    );
  } catch (error) {
    console.error("");
    console.error("Error:", error.message);
    process.exit(1);
  }
}

async function setDefault(domain) {
  try {
    await CliWallet.setDefaultDomain(domain);
    console.log(`✓ Default domain set to: ${domain}`);
    console.log("");
    console.log("Verify with: epistery info");
  } catch (error) {
    console.error("");
    console.error("Error:", error.message);
    process.exit(1);
  }
}


function parseCurlArgs(args) {
  const options = {
    domain: null, // null means use default
    method: "GET",
    data: null,
    headers: [],
    bot: true, // Use bot mode by default
    verbose: false,
    url: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "-w":
      case "--wallet":
        options.domain = args[++i];
        break;

      case "-X":
      case "--request":
        options.method = args[++i].toUpperCase();
        break;

      case "-d":
      case "--data":
        options.data = args[++i];
        break;

      case "-H":
      case "--header":
        options.headers.push(args[++i]);
        break;

      case "-b":
      case "--bot":
        options.bot = true;
        break;

      case "-v":
      case "--verbose":
        options.verbose = true;
        break;

      default:
        if (!arg.startsWith("-")) {
          options.url = arg;
        } else {
          throw new Error(`Unknown option: ${arg}`);
        }
    }
  }

  if (!options.url) {
    throw new Error("URL required");
  }

  return options;
}

async function executeCurl(curlArgs, stdinData) {
  return new Promise((resolve, reject) => {
    const curl = spawn("curl", curlArgs);

    // Feed the request body over stdin when curl was told to read it from `@-`,
    // so the transmitted bytes are exactly what we signed.
    if (stdinData !== undefined) {
      curl.stdin.write(stdinData);
      curl.stdin.end();
    }

    let stdout = "";
    let stderr = "";

    curl.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    curl.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    curl.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`curl exited with code ${code}: ${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });

    curl.on("error", (error) => {
      reject(new Error(`Failed to execute curl: ${error.message}`));
    });
  });
}

async function performCurl(options) {
  try {
    // Load wallet (uses default if domain not specified)
    const wallet = await CliWallet.load(options.domain);

    if (options.verbose) {
      console.error(`[epistery] Domain: ${wallet.getDomain()}`);
      console.error(`[epistery] Address: ${wallet.address}`);
      console.error(`[epistery] Auth mode: ${options.bot ? "bot" : "session"}`);
      console.error("");
    }

    // Build curl command
    const curlArgs = ["-s"]; // Silent mode

    if (options.verbose) {
      curlArgs.push("-v");
    }

    // HTTP method
    curlArgs.push("-X", options.method);

    // Resolve the request body up front, so the SAME bytes are both signed and
    // sent. curl reads `-d @file` from disk, but bot-auth (below) hashes
    // whatever we pass as `body`; signing the literal "@path" while curl sent
    // the file's contents made the body digest mismatch and the server reject
    // an otherwise-authorized bot write. Read the file ourselves instead.
    let requestBody = options.data;
    if (typeof requestBody === "string" && requestBody.startsWith("@")) {
      const bodyPath = requestBody.slice(1);
      try {
        requestBody = readFileSync(bodyPath, "utf8");
      } catch (e) {
        throw new Error(`Cannot read request body file "${bodyPath}": ${e.message}`);
      }
    }

    // Authentication
    if (options.bot) {
      // Bot mode: the signature covers this exact request — method, URI,
      // audience host and body digest — so it cannot be lifted onto another
      // call. Everything the header commits to must match what curl sends.
      const authHeader = await wallet.createBotAuthHeader({
        method: options.method,
        url: options.url,
        body: requestBody,
      });
      curlArgs.push("-H", `Authorization: ${authHeader}`);
    } else {
      // Session mode: Check for existing session or perform key exchange
      // Extract base URL (protocol + host + port) for key exchange
      const url = new URL(options.url);
      const baseUrl = `${url.protocol}//${url.host}`;

      let session = wallet.getSession(baseUrl);

      if (!session) {
        if (options.verbose) {
          console.error(
            "[epistery] No session found, performing key exchange...",
          );
          console.error(`[epistery] Connecting to: ${baseUrl}`);
        }

        // Perform key exchange automatically
        const response = await wallet.performKeyExchange(baseUrl);

        if (options.verbose) {
          console.error(`[epistery] Key exchange successful`);
          console.error(`[epistery] Server: ${response.serverAddress}`);
          console.error(`[epistery] Authenticated: ${response.authenticated}`);
          console.error("");
        }

        session = wallet.getSession(baseUrl);
      }

      if (session && session.cookie) {
        curlArgs.push("-H", `Cookie: _epistery=${session.cookie}`);
      } else {
        throw new Error("Failed to obtain session cookie");
      }
    }

    // Request body. Send the resolved bytes over stdin (`--data-binary @-`) so
    // curl transmits them verbatim — no newline stripping, and no re-reading a
    // leading "@" as a filename — keeping the sent body byte-identical to what
    // the bot signature hashed above.
    if (options.data) {
      curlArgs.push("-H", "Content-Type: application/json");
      curlArgs.push("--data-binary", "@-");
    }

    // Additional headers
    for (const header of options.headers) {
      curlArgs.push("-H", header);
    }

    // URL (last argument)
    curlArgs.push(options.url);

    if (options.verbose) {
      console.error("[epistery] Executing: curl", curlArgs.join(" "));
      console.error("");
    }

    const { stdout, stderr } = await executeCurl(
      curlArgs,
      options.data ? requestBody : undefined,
    );

    if (stderr && options.verbose) {
      console.error(stderr);
    }

    console.log(stdout);
  } catch (error) {
    console.error("");
    console.error("Error:", error.message);
    process.exit(1);
  }
}

/**
 * MCP stdio bridge — reads JSON-RPC from stdin, POSTs to remote /mcp
 * with bot-auth, writes responses to stdout.
 *
 * Usage: epistery mcp [-w domain] <url>
 *   claude mcp add --transport stdio my-site -- epistery mcp https://my-site.example
 */
async function performMcp(args) {
  // Parse args: [-w domain] <url>
  let domain = null;
  let url = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-w' || arg === '--wallet') {
      domain = args[++i];
    } else if (!arg.startsWith('-')) {
      url = arg;
    }
  }

  if (!url) {
    console.error('Error: URL required');
    console.error('Usage: epistery mcp [-w domain] <url>');
    process.exit(1);
  }

  // Ensure URL ends without trailing slash, append /mcp if not present
  const mcpUrl = url.replace(/\/+$/, '').endsWith('/mcp')
    ? url.replace(/\/+$/, '')
    : url.replace(/\/+$/, '') + '/mcp';

  const wallet = await CliWallet.load(domain);

  // A console SESSION (<origin>/p/<kind>/<owner>/<id>) is not proxied: its /mcp
  // takes access keys, and this rivet is a member in its own right. Its tools
  // are served here, as this rivet, by @epistery/plugins/local-mcp — which
  // derives the session key from the rivet's own leaf and seals and signs
  // locally, so the server sees only ciphertext and signatures.
  if (new URL(mcpUrl).pathname.startsWith('/p/')) {
    const local = await import('@epistery/plugins/local-mcp');
    await local.serve({ url: mcpUrl, wallet });
    return;
  }

  const fetch = (await import('node-fetch')).default;

  // All log output to stderr so stdout stays clean for MCP JSON-RPC
  process.stderr.write(`[epistery-mcp] Bridge: ${wallet.address} -> ${mcpUrl}\n`);

  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // Not valid JSON — ignore
      continue;
    }

    const isNotification = msg.id === undefined || msg.id === null;

    try {
      // Fresh bot-auth header per request. The signature covers this JSON-RPC
      // message: swap the body and the signature stops verifying, so a captured
      // header cannot be used to call a different tool.
      const payload = JSON.stringify(msg);
      const authHeader = await wallet.createBotAuthHeader({
        method: 'POST',
        url: mcpUrl,
        body: payload
      });

      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: payload
      });

      if (res.status === 204) {
        // No content (notification acknowledged) — nothing to write
        continue;
      }

      const body = await res.text();

      if (!res.ok) {
        // Server error — wrap in JSON-RPC error if this was a request
        if (!isNotification) {
          const errResponse = {
            jsonrpc: '2.0',
            error: { code: -32000, message: `HTTP ${res.status}: ${body}` },
            id: msg.id
          };
          process.stdout.write(JSON.stringify(errResponse) + '\n');
        }
        continue;
      }

      if (body) {
        process.stdout.write(body.trim() + '\n');
      }
    } catch (err) {
      // Network error
      if (!isNotification) {
        const errResponse = {
          jsonrpc: '2.0',
          error: { code: -32000, message: err.message },
          id: msg.id
        };
        process.stdout.write(JSON.stringify(errResponse) + '\n');
      }
      process.stderr.write(`[epistery-mcp] Error: ${err.message}\n`);
    }
  }
}

async function main() {
  const command = process.argv[2];
  const rawArgs = process.argv.slice(3);

  // Extract global options (like -p/--port) from args
  const { options: globalOpts, remainingArgs: args } =
    extractGlobalOptions(rawArgs);
  const port = globalOpts.port;

  try {
    switch (command) {
      case "initialize": {
        const { chain, remainingArgs: initArgs } = extractChainOption(args);
        if (!initArgs[0]) {
          console.error("Error: Domain name required");
          console.error("Usage: epistery initialize [-c <chain>] <domain>");
          process.exit(1);
        }
        await initializeDomain(initArgs[0], chain);
        break;
      }

      case "chains":
        await listChains();
        break;

      case "permissions":
        await permissionsCommand(args.includes("--fix") || args.includes("-f"));
        break;

      case "set-chain":
        if (!args[0] || !args[1]) {
          console.error("Error: Domain and chain required");
          console.error("Usage: epistery set-chain <domain> <chainId|name>");
          console.error("");
          console.error("Supported chains:");
          await printChains("  ");
          process.exit(1);
        }
        await setChainCommand(args[0], args[1]);
        break;

      case "set-default-chain":
        if (!args[0]) {
          console.error("Error: Chain required");
          console.error("Usage: epistery set-default-chain <chainId|name>");
          console.error("");
          console.error("Supported chains:");
          await printChains("  ");
          process.exit(1);
        }
        await setDefaultChainCommand(args[0]);
        break;

      case "mcp":
        if (rawArgs.length === 0) {
          console.error("Error: URL required");
          console.error("Usage: epistery mcp [-w domain] <url>");
          console.error("");
          console.error("Stdio MCP bridge with bot-auth. Register with Claude Code:");
          console.error("  claude mcp add --transport stdio my-site -- epistery mcp https://my-site.example");
          process.exit(1);
        }
        await performMcp(rawArgs);
        break;

      case "curl":
        if (rawArgs.length === 0) {
          console.error("Error: URL required");
          console.error("Usage: epistery curl [options] <url>");
          console.error("Run epistery --help for more information");
          process.exit(1);
        }
        // curl has its own option parsing, use rawArgs
        const curlOptions = parseCurlArgs(rawArgs);
        await performCurl(curlOptions);
        break;

      case "info":
        await showInfo(args[0] || null);
        break;

      case "set-default":
        if (!args[0]) {
          console.error("Error: Domain name required");
          console.error("Usage: epistery set-default <domain>");
          process.exit(1);
        }
        await setDefault(args[0]);
        break;

      case "help":
      case "--help":
      case "-h":
        showHelp();
        break;

      default:
        if (command) {
          console.error(`Error: Unknown command '${command}'`);
          console.error("");
        }
        showHelp();
        process.exit(command ? 1 : 0);
    }
  } catch (error) {
    console.error("");
    console.error("Error:", error.message);
    process.exit(1);
  }
}

main();
