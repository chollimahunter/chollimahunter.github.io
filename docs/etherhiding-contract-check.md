# contract-check — EtherHiding on-demand checker tool (design)

## Status

Implemented as `scripts/check-etherhiding-contracts.js`, and run every other day by
`.github/workflows/etherhiding-refresh.yml` (06:15 UTC, and on demand). The
workflow re-reads every watchlist entry against pools of public, keyless RPC
endpoints for Ethereum and BNB Smart Chain, with Blockscout as the Ethereum
indexer, and opens or updates one standing pull request on
`etherhiding/refresh` only when the script prints `CHANGED=true`, that is,
when an observation moved: a C2 rotated, a payload changed, bytecode was
replaced, or an operator's nonce advanced. No credential is configured or
bundled. The tool can still be run by hand with the commands below.

Until October 2026 nothing ran it on a schedule, and the watchlist held none of
the EtherRAT contracts already in published reporting. A resolver exists to be
rewritten, so a watchlist read once goes stale within days; that is why the
refresh is scheduled rather than left to a person to remember.

### EtherRAT mapping contracts

EtherRAT keeps its C2 in a contract holding `mapping(address => string)`. The
operator writes with `setString(string)` (selector `0x7fcaf666`) and the
implant reads with `getString(address)` (selector `0x7d434425`), passing the
operator's own wallet as the key. Neither the storage walk nor the selector
probe can see that value: a mapping entry lives at `keccak(key . slot)`, and
the accessor takes an argument. A watchlist entry for such a contract
therefore carries `"onchain_role": "mapping_c2_contract"` and an `operators`
array, and every run calls `getString` for each operator exactly as the
implant does, then, with an indexer, decodes every `setString` call into the
rotation history. A value no watchlist entry carries is reported as NOT IN
WATCHLIST, and a write from a wallet the entry does not name is called out.
Operators also park the resolver on a bare well-known domain between sessions:
read on 2026-10-11, each real host stayed minutes to hours, a parked value
filled every gap of days or weeks, and every contract's current value was a
parked one. A new value is therefore a lead for review, never an indicator by
itself; registration data (same registrar and nameservers, registered the day
it was written) is what separated real hosts from parked values when the first
two contracts were read. No published report describes the parking; it is this
site's reading of the write timing.

### XCTDH TRON and Aptos pointers

The cross-chain variant Ransom-ISAC calls XCTDH keeps no C2 on Ethereum. A
TRON wallet's most recent outbound transaction carries, in `raw_data.data`, a
reversed BSC transaction hash (an Aptos account's latest `arguments[0]` is the
fallback), and that BSC transaction's calldata is an XOR-encrypted, obfuscated
script that names the C2. The checker's JSON-RPC reads do not cover these
chains, but the refresh reads the pointers themselves (below). The payload
dates were read by hand on 2026-10-04: each pointer's writes from TronGrid and the
Aptos REST API, each named BSC transaction from a public node, the XOR key
recovered by frequency analysis (the cited keys, rotated), and the string
tables unshuffled offline. The result sits on the pointer's watchlist entry as
`c2_history`, one run per host (`host`, `since`, `until`, and where known `pointer_tx`,
`payload_tx` and a `basis` saying how the date was read), and dates the ties its `c2_hosts` list states. The JADESNOW BSC contract and the two ClickFix configuration contracts carry it too, from their own on-chain writes. The September
2026 chain 1 payload decodes to `181.214.149.148:443`, matching the report.
Payload variants that use the later decompressor layer were not decoded, so
an entry without `c2_history` keeps its undated, report-stated ties.

Since 2026-10-11 the refresh reads every `tron` and `aptos` pointer entry
(`scripts/lib/etherhiding-pointers.js`): all of the account's outbound
transactions from TronGrid (`api.trongrid.io`) or the Aptos REST API
(`api.mainnet.aptoslabs.com/v1`), both public and keyless, keeping the ones that
name a BSC transaction hash. Each pointer becomes an observation of kind
`pointer` whose `rotation` holds one run per named BSC transaction, in the shape
the EVM resolver wallets use (`to` is the BSC hash; `from`, `until`, `count`,
`first_tx`, `last_tx` as usual). A new write is therefore a new run the review
gate lists as a `new:` line, an "operator activity" change, and a later
last-active date on the tracker. A failed read adds a query ending `-- FAILED`,
which counts toward the gate's degraded-run threshold like a failed EVM query,
and the previous run's rotation is carried forward. The refresh does not fetch
or decode the BSC payloads a write names, so the hosts in `c2_history` still
move only when someone decodes the new payload by hand
(`_drafts/xctdh-decoder/`); the `new:` line is the prompt to do so. The 2026-10-11 re-read added the
2026-10-05 payloads, which decode to `89.19.222.25`, the same host the Ethereum
signal wallet switched to that day. Of the 2026-10-07 writes, the TFMry chain's
latest payloads are 13 and 14 bytes of filler (one reads `'error';`). The
TCqf chain's two full payloads are a new loader, decoded statically on
2026-10-11 (`_drafts/xctdh-decoder/README.md`): it scans Ethereum for a
transaction sent from a second signal address, 0x596dcc9f..., reads its
recipient as packed BNB Smart Chain block and transaction pointers, and loads
XOR-encrypted scripts from those transactions. The second pointer's script
is a socket.io remote-access tool naming `154.91.0.20:443` and
`166.0.106.182`; the third uses the obfuscator.io format that stays undecoded.
The first signal wallet moved to `103.213.248.45` and `136.0.7.231` the same
day.

## Running it

```
node scripts/check-etherhiding-contracts.js --address 0x8eac...          # mode 1
node scripts/check-etherhiding-contracts.js --file candidates.txt        # mode 1
node scripts/check-etherhiding-contracts.js --address 0x... --rpc <url>  # mode 2
node scripts/check-etherhiding-contracts.js --tx 0x... --rpc <url>       # mode 2, calldata
node scripts/check-etherhiding-contracts.js --refresh   --rpc bsc=<url> --rpc ethereum=<url>                                   # mode 3
```

| Flag | Effect |
|---|---|
| `--address <0x...>` | Candidate address to check. Repeatable. |
| `--file <path>` | File of candidate addresses, one per line; `#` starts a comment. |
| `--refresh` | Mode 3. Requires `--rpc`. |
| `--rpc <url>` | JSON-RPC endpoint, enabling modes 2 and 3. Repeatable, and accepts `<chain>=<url>` so a watchlist spanning chains is covered in one run. Also read from `ETHERHIDING_RPC_URL`. |
| `--tx <0x...>` | Candidate transaction hash, read for its calldata. Repeatable. |
| `--chain <label>` | Chain label recorded with each query. Defaults to the RPC host. |
| `--history` | Walks each watchlisted contract's payload write history by binary-searching archive state. Needs an endpoint that serves `eth_getStorageAt` at old blocks; recovers the rotation history on a chain with no reachable transaction-list API. |
| `--indexer <url>` | Transaction-list API for a chain, `<chain>=<url>`. Etherscan-compatible `txlist` shape; Blockscout serves it without a key. Enables the full resolver rotation history rather than its latest entry alone. |
| `--explorer <url>` | Block-explorer API base, e.g. `https://api.bscscan.com/api`. Optional: selectors are recovered from the deployed bytecode without it. Also `ETHERHIDING_EXPLORER_URL`. |
| `--explorer-key <k>` | Explorer API key. Also `ETHERHIDING_EXPLORER_KEY`. |
| `--dry-run` | Print the findings file to stdout instead of writing it. |

Without `--rpc` the tool runs mode 1 only and makes no network requests at all.

The 4-byte selector each `eth_call` needs is derived with
`scripts/lib/keccak256.js`. Node's built-in `crypto` cannot do this: its
`sha3-256` is NIST SHA-3, which differs from Ethereum's keccak256 in the
domain-separation padding byte and therefore yields an entirely different
digest, so a selector built from it would invoke the wrong method or none at
all. That module checks itself against published Keccak-256 vectors and the
ERC-20 `transfer(address,uint256)` selector before the tool touches the
network.

## Purpose

Check a candidate smart contract address -- or a batch of addresses, or the
data of a contract the site owner already suspects -- against the
`etherhiding-watchlist.json` IOC list, and against the published payload
detection patterns in that list, then write the outcome as a `scan_result`
object the results page can render.

This tool is a **lookup/checking aid, not a verdict engine**. A match means
"this address or pattern appears in a publicly cited threat-intel report" --
it is not, by itself, proof that a given contract is currently serving
malicious content, and on-chain data being public does not mean intent is
established. Every finding this tool produces must be presented to the
reader as requiring manual review (see Phase 5 / results page disclaimer).

## Inputs

- **Watchlist**: `src/_data/iocs/etherhiding-watchlist.json` -- read fresh on
  every run. Array of IOC entries (see that file for the current field
  shape). For this feature `ioc_type` is one of `smart_contract_address`,
  `wallet_address`, `transaction_hash`, `file_hash`, `ip_address` or
  `c2_pattern`. Only the first two are address-shaped and therefore checkable
  against a chain; the rest are carried for reference and for the searchable
  listing on /etherhiding/.

  A `c2_pattern` entry's `value` is prose describing a published rule, which
  is right for a reader and useless to a matcher. To be applied mechanically an
  entry also needs a `detection` block holding the literal strings that rule
  requires:

  ```json
  "detection": {
    "kind": "all_of_strings",
    "max_bytes": 10240,
    "not_starts_with": "MZ",
    "strings": [
      { "text": "global['_V']", "min_occurrences": 1 },
      { "text": "umP", "min_occurrences": 3 },
      { "text": "charAt", "min_occurrences": 1, "case_insensitive": true }
    ]
  }
  ```

  A string may also carry `max_occurrences` to pin an exact count.
  JADESNOW's published condition is `#s5 == 1` -- one occurrence of `charAt`
  and no more -- and treating that as a floor would fire on files its author
  deliberately excluded. `max_bytes` is an **exclusive** ceiling, matching
  YARA's `filesize < 10KB`.

  Every string must be present at its stated count for the entry to fire,
  mirroring the AND in the source rule rather than triggering on one common
  substring. `max_bytes` and `not_starts_with` carry the size and file-type
  conditions the published rule states. Populate the block only from what the
  cited report actually specifies -- inventing a plausible extra string turns a
  sourced rule into an unsourced one. An entry with no `detection` block is
  **not** silently skipped: the run records it in `queries_executed` as
  unevaluated, because a pattern the tool could not apply must not be
  indistinguishable from one that was applied and did not match.
- **Candidate address(es)**: supplied by the site owner at run time -- either
  a single address, a text file of addresses (one per line), or "check the
  whole watchlist for freshness" (see Mode 3 below).
- **RPC / block-explorer endpoint** (required only for Modes 2 and 3, below):
  the site owner must supply one of:
  - A public JSON-RPC endpoint URL for the target chain (e.g. a public
    Ethereum or BNB Smart Chain RPC endpoint), used with a minimal
    `eth_getCode` / `eth_call` request to read a contract's deployed
    bytecode or a specific method's return data, or
  - A block-explorer API key (e.g. Etherscan/BscScan-style API), used to
    fetch verified source, ABI, or contract creation/transaction data for an
    address.

  **This tool ships with neither.** No key or endpoint is hardcoded or
  bundled. If the site owner runs Mode 2/3 without supplying one, the tool
  must stop and report that a live check could not be performed, rather than
  silently skipping the on-chain portion or fabricating a result.

## Modes

Modes 1 and 3 treat both `smart_contract_address` and `wallet_address`
entries as candidates, since each is a 20-byte EVM address and only what sits
at it differs. Transaction and file hashes are never compared as addresses.

### Mode 1 -- Watchlist-only match (no network access required)

Given one or more candidate addresses, do a direct string match (case-
insensitive; EVM addresses are not case-sensitive at the protocol level,
though checksum-casing per EIP-55 may differ across sources) against the
`value` field of every address-shaped entry in the watchlist. This mode needs
no RPC/API key and can always run.

### Mode 2 -- Live contract data check (requires RPC/explorer endpoint)

Given a candidate address and a site-owner-supplied RPC endpoint or explorer
API key:

1. Fetch the contract's deployed bytecode (`eth_getCode`) and, where a
   verified ABI/source is available via the explorer API, the readable
   source.
2. Fetch return data from the contract's read-only ("view"/"pure") methods.
   Which method holds the payload is the whole problem here, and the contract
   answers it itself: Solidity compiles the public interface into the deployed
   bytecode as PUSH4 selector constants, so the dispatch table is recovered by
   walking the code (respecting PUSH operands, so a PUSH32 constant containing
   `0x63` is not misread as an opcode). Those selectors are probed first, then
   the verified ABI's methods where `--explorer` was supplied, then the guessed
   getter names led by `getString()` and `getName()` -- which now serve mainly
   to put a name to a recovered selector. Each returned value is ABI-decoded as
   a `string`/`bytes` where the layout fits, scanned for printable ASCII runs
   where it does not, and any base64 blob inside it is decoded one level, since
   reported payloads are commonly stored encoded and testing only the raw bytes
   would miss them by construction.

   Recovering the table is what made the check work. The guess list alone never
   once returned data from the watchlisted BSC contract; the dispatch table
   named `0xbf6332c3`, which returns the stored payload.
3. Test the retrieved bytecode/return-data text against the watchlist's
   `c2_pattern` entries (e.g. the JADESNOW YARA-style string indicators) --
   this is a heuristic string/pattern match, not sandboxed code execution.
   **Never `eval()`/execute retrieved contract data** -- inspect it as
   inert text/bytes only.
4. Where a candidate is a transaction hash, read the transaction
   (`eth_getTransactionByHash`) and test its calldata the same way. This is not
   a secondary path: the reported INVISIBLEFERRET payloads were never in
   contract state at all but sent as calldata to the burn address, so a checker
   that only reads contracts cannot see the place the payload is known to be.
5. Read every address seen -- candidate or transaction recipient -- as an
   encoded payload in its own right. NullReceiver stores nothing on chain and
   encodes its C2 address in the 20 bytes of the recipient, one byte per octet,
   so `0xa658863e...` is `166.88.134.62`. Reading the address as ASCII finds
   only the trailing label and misses the address the malware exists to carry.
   A decode is reported when corroborated -- the same non-zero group written
   twice, or a substantial printable label beside it -- because any 20-byte
   value renders as five IPv4-shaped strings and the shape alone means nothing.
6. Record what was queried (method name/selector, chain, block height at
   time of query) in `queries_executed` for transparency. When data was
   retrieved and matched nothing, record what it looked like instead: view
   count, longest view, highest Shannon entropy and which view carried it, and
   which of a fixed token vocabulary appeared. Entropy separates "no payload is
   there" from "a payload is there and encoded", and only the first is what a
   bare "no match" reads as. The description is recorded; the attacker-supplied
   content itself is not copied into this repository.

An address- or transaction-shaped entry should also carry a `chain` (`"bsc"`,
`"ethereum"`). `--rpc` is repeatable and accepts `<chain>=<url>`, so one run
covers both: each entry is routed to the endpoint for its own chain, and an
entry whose chain nobody supplied an endpoint for is recorded as not checked
rather than reported absent from the one chain that was queried. An endpoint
that fails is recorded and the run continues on the chains that answered.

### Mode 3 -- Watchlist freshness re-check

Re-run Mode 2 against every watchlisted address and transaction hash, to see
whether a previously reported contract is still live, whether its stored
payload data has changed, or whether its funding/owner address has new
activity. An entry marked `"onchain_role": "owner_eoa"`, and any
`wallet_address`, is expected to hold no code, so its empty bytecode is
recorded as the expected result rather than as a contract that has gone
quiet -- a line that reads as a finding on every run teaches a reader to skim
past the one that is. Useful for noting "still active" / "appears
abandoned" in a future watchlist update -- results still get written as a
`scan_result`, they do not silently rewrite the watchlist itself.

## From checker to tracker

The first build answered one question: is this published address still there?
That can only ever confirm what someone else already found, and it is why the
first findings file had nothing in it. Three changes move the tool from
checking a list to watching infrastructure.

**Read storage, not accessors.** Solidity's layout for a long string is public:
the declared slot holds `2 * length + 1` and the bytes follow from
keccak256(slot). Reading a payload that way needs no ABI, no method name and no
API key, and it works when the accessor takes arguments or was never exposed.
`scripts/lib/etherhiding-shape.js` does this.

**Score the shape, not just the strings.** The published patterns describe the
stage-one downloader on a victim's disk, so nothing in them can recognise a
dead drop the tool has not been told about. What is recognisable is structure:
kilobytes of high-entropy base64 in a storage string, behind an owner-gated
setter, often under a token-shaped name for cover. The known BSC contract
scores 100; CAKE, WBNB and BUSD score 0 to 10. The score describes structure
and is explicitly not an attribution -- a contract can hold a large encoded
string for entirely ordinary reasons, on-chain SVG art among them, so a high
score is a reason to look and the reasons travel with the number.

**Compare runs.** Every observation carries content hashes -- payload, bytecode,
calldata -- plus an EOA's nonce. Each run diffs against the last and writes a
`changes` array: payload rotated, bytecode replaced, operator nonce advanced.
A dead-drop resolver exists to be rewritten, and a rotation is invisible to any
static indicator list. This also fixed `CHANGED`: the old signature hashed the
query log, which names the block height, so every run reported a change and a
scheduled pull request would have been meaningless.

**Enumerate, where an indexer is available.** JSON-RPC can fetch a transaction
you already name and nothing else, so it cannot answer "what has this address
done". `--indexer <chain>=<url>` takes an Etherscan-compatible `txlist` API --
Blockscout serves one without a key, e.g.
`ethereum=https://eth.blockscout.com/api` -- and turns a resolver wallet's
history into the sequence of addresses it has pointed at, with dates and
counts. This is what took the C2 rotation from a lucky single read to a
reproducible run.

**Follow the resolver.** NullReceiver resolves its C2 from the most recent
outbound transaction of a wallet, so the tool reads that same transaction and
decodes the recipient. This is the one part that can outrun its own watchlist:
when the resolved address is watchlisted it is reported as a match, and when it
is not, the run says plainly that the published C2 is stale and that the
observation needs review before being treated as an indicator. With an
indexer, that transaction is the newest entry of the history already read, so
no extra call is needed. Without one, it needs an endpoint serving
`eth_getTransactionBySenderAndNonce`; most public ones do not, and the run
records that rather than reporting the wallet as unchanged. Multiple `--rpc`
flags for the same chain form a failover pool, which is what makes a
capable-but-flaky endpoint usable alongside a stable one.

Recipients are decoded by the same `decodedIps` the tracker uses
(`scripts/lib/etherhiding-addresses.js`), which reads both shapes in use:
NullReceiver's repeated IP (`a658863e a658863e` + label) and the XCTDH signal
wallet's IP, port, IP, port (`67d5f82d 01bb 880007e7 0050`, ports 443 and 80),
where the two IPs can differ. A rotation run that decodes to two carries both
in `resolved_ips`.

## Output

Aggregate findings into this `scan_result` shape (the same pattern used by
the repo-scanner feature's `src/_data/scanResults/latest.json`):

```json
{
  "scan_id": "<uuid-or-timestamp-based-id>",
  "ran_at": "<ISO 8601 timestamp>",
  "ruleset_version": "<watchlist file name + sha256 content hash + entry count, e.g. 'etherhiding-watchlist.json @ sha256:3f2a... (38 entries)'>",
  "matches": [
    {
      "ioc_id": "<matching watchlist entry's id>",
      "matched_value": "<the candidate address or extracted pattern that matched>",
      "location": "<candidate address / chain / tx or contract-read reference>",
      "matched_at": "<ISO 8601 timestamp of this specific match>",
      "context": "<what matched and how -- e.g. 'candidate address string-matched watchlist entry value' or 'contract eth_getCode output contained JADESNOW YARA string indicator umP (3 occurrences)'>"
    }
  ],
  "changes": [
    {
      "target": "<address or tx this observation is about>",
      "chain": "<chain label>",
      "change": "<e.g. 'payload rotated', 'bytecode replaced', 'operator nonce advanced'>",
      "detail": "<what changed, in prose, e.g. content hashes before and after>"
    }
  ],
  "observations": [
    "<this run's per-target reads -- content hashes for payload/bytecode/calldata plus an EOA's nonce, diffed against the previous run to produce changes above>"
  ],
  "queries_executed": [
    "<query strings actually run, e.g. 'eth_getCode 0x... on bsc-dataseed.binance.org at block 41,xxx,xxx'>"
  ],
  "status_note": "<prose summary -- mode, targets and watchlist entries checked, match count -- and the standing caveat that a match is not a determination of compromise>"
}
```

Write this object directly to
`src/_data/etherhidingFindings/latest.json`, overwriting the previous run.
Keep exactly one `latest.json` -- if historical runs need to be preserved,
that's a future enhancement (e.g. `src/_data/etherhidingFindings/history/`),
not part of this design.

## Constraints / non-goals

- **No result from this tool is a claim of confirmed compromise.** The
  results page (`src/etherhiding/results.njk`) must render the
  `.disclaimer-banner` component alongside every findings table, and this
  document itself states the same rule for anyone invoking the tool
  directly.
- **Never fabricate a match, a queried value, or an on-chain read.** If a
  query fails (endpoint unreachable, rate-limited, address not a contract),
  record that failure plainly in `queries_executed` -- do not omit it or
  invent a plausible-looking result.
- **Never execute retrieved contract data.** Treat all fetched
  bytecode/calldata/return values as inert bytes to pattern-match against,
  never as code to run, consistent with how a defender should treat
  attacker-controlled blockchain data.
- **This tool needs the site owner to supply live infrastructure
  (RPC/explorer endpoint) to do anything beyond Mode 1.** That is a
  deliberate scope boundary of this build -- see `Inputs` above.
- Reuses the same `scan_result` shape as the repo-scanner feature's findings
  file as-is; if a future need arises for an additional field (e.g. `chain`
  per match), add it consistently to both features' findings files rather
  than letting the two shapes diverge.

## Verification

Mode 1 and the mode 3 refusal path run offline and need nothing. The on-chain
path was checked end to end against the benign demonstration contract from
Cymulate's published reproduction of the technique, deployed at
`0xaE3Ba9d7C1374234b29525AE1EA07Ea93D30F5eD` on Ethereum Sepolia: the tool
reads its bytecode, recovers `getName()` from the guess list, calls it, and
ABI-decodes the stored value. That address is a test target only. It is a
researcher's own contract, carries no DPRK attribution, and is deliberately
not in the watchlist.

Mode 3 has since been run against the whole watchlist across both chains, at
BSC block 119,655,593 and Ethereum block 25,894,123, using public RPC
endpoints (`bsc-rpc.publicnode.com`, `eth.drpc.org`) with no API key. Every
watchlisted address and transaction was reached. Three things that run
established:

- The reported BSC contract is still deployed and still serving a payload.
  Recovering its dispatch table from bytecode found `0xbf6332c3`, which
  returns 5,280 bytes decoding to a 5,216-character base64 string; that string
  decodes to 3,909 bytes at 6.64 bits/byte, so the payload is encoded or
  encrypted rather than the plaintext JavaScript the published YARA rule
  describes. It is not single-byte XOR. Ten months after the GTIG report, the
  dead drop is still stocked.
- The three Ethereum transactions carry 6,913, 16,757 and 27,057 bytes of
  calldata, all sent to `0x0000...dEaD` with zero value, matching the sizes
  and the burn-address destination in the reporting. Their contents are
  likewise high-entropy.
- The NullReceiver destination decodes exactly as reported: bytes 0-3 and 4-7
  are both `166.88.134.62`, followed by the printable label `helloipbot!!`.
  That is the run's one match, and it is a match against the watchlisted C2 IP
  reached independently from chain data rather than from the citation.

Enumerating the NullReceiver resolver wallet's 285 outbound transactions on
2026-09-03 produced the finding this redesign was built for. The resolved
destination has rotated three times: 166.88.134.62 from 2026-07-25 to
2026-08-22 across 178 transactions, 23.27.13.135 from 2026-08-22 to 2026-08-27
across 48, and 166.88.73.46 from 2026-08-28 to 2026-09-03 across 58. Only the
first is in the cited reporting. The other two are now watchlisted on this
site's own observation, each citing the transaction it was read from, and each
first transaction was re-fetched by hash from an independent RPC provider that
returned the same sender, recipient, zero value and empty calldata.

No match fired against `G_Downloader_JADESNOW_1` anywhere, which is expected:
that rule describes the stage-one downloader on a victim's disk, not the
encoded blob a contract hands back, and its `max_bytes: 10240` excludes the
larger calldata besides. Mode 3's value here is liveness and characterization,
not discovery, and the findings file should be read that way.

## References

- Blas Kojusner, Robert Wallace, Joseph Dobson, "DPRK Adopts EtherHiding:
  Nation-State Malware Hiding on Blockchains," Mandiant / Google Threat
  Intelligence Group, October 16, 2025. Source of every watchlist entry,
  including the JADESNOW YARA rule the `detection` block encodes.
- "Simulating EtherHiding: Blockchain as a Malware," Cymulate. Source of the
  `getName()` accessor name in the guess list and of the Sepolia test target
  above. Cited for retrieval mechanics only, not for attribution.
