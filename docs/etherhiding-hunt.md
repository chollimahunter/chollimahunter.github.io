# EtherHiding hunt

`scripts/hunt-etherhiding.js`, run monthly (the 1st) by `.github/workflows/etherhiding-hunt.yml`,
looks for EtherHiding contracts the watchlist does not carry. It follows the
method Alex Necula described on LinkedIn on 7 and 12 October 2026: a contract
that overwrites its stored C2 still leaves every earlier value in the inputs of
the transactions that set it, and some operators also emit an event such as
`DataUpdated(string,string)` on every rotation.

For each EVM contract and wallet in the watchlist on a chain with an indexer,
it:

1. reads every transaction sent to the contract and decodes the string
   arguments of each input as text, giving the write history with dates and
   transaction hashes;
2. reads the contract's logs for the rotation events listed in `EVENTS`;
3. follows the wallets that wrote, and the deployer, to the other contracts
   they deployed or wrote strings to;
4. sweeps the last 300,000 blocks (about a week on Polygon, six weeks on
   Ethereum) for any contract emitting one of those
   events.

Nothing is filed and nothing is decrypted or run. The job summary lists the
candidates whose values look like hosts, IPs, base64 or gzip-base64 (`H4sI`),
defanged; the artifact holds the full JSON. A candidate needs review before it
becomes a watchlist entry, and one with no published DPRK link is filed with
`attribution_doubt`.

Ethereum is read through keyless Blockscout. Polygon's Blockscout refuses CI
runners (403 on both its /api and /api/v2), so the workflow reads Polygon
through Etherscan's V2 API when the `ETHERSCAN_API_KEY` repository secret is
set (a free key from etherscan.io covers it) and warns and skips it otherwise.
BNB Smart Chain is read through NodeReal (`nr_getTransactionByAddress`, then
each transaction's input) with the `NODEREAL_API_KEY` secret, given as
`--indexer bsc=nodereal`. Both keys are read from the environment only.

With `--writes`, the write history of every watchlisted contract goes to
`src/_data/etherhidingFindings/writes.json`, newest value per transaction cut
to 300 characters; a contract a run could not read keeps its earlier history.
The Write transactions table on each contract's indicator page shows it, and
the monthly run commits it through the `etherhiding/writes` pull request.

Run it by hand:

    node scripts/hunt-etherhiding.js --indexer polygon=https://polygon.blockscout.com/api \
      --seed polygon:0x... --out _drafts/etherhiding-hunt/latest.json
