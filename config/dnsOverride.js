// Some networks hand out a resolver that Node's own DNS client (c-ares) can't complete
// SRV lookups against, even though the OS resolver (nslookup, browsers) works fine —
// this breaks mongodb+srv:// URIs with "querySrv ECONNREFUSED". Opt in with DNS_SERVERS
// (comma-separated) to route Node's lookups through a public resolver instead.
//
// Every entry point that connects to Mongo directly (server.js and the one-off scripts
// under scripts/, which don't go through config/db.js) must call this before requiring
// mongoose — an SRV lookup fired before the override is applied still fails.
function applyDnsOverride() {
  if (process.env.DNS_SERVERS) {
    require("dns").setServers(
      process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean)
    );
  }
}

module.exports = { applyDnsOverride };
