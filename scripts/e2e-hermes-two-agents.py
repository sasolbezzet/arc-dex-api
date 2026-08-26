#!/usr/bin/env python3
"""L2 E2E: two real Hermes device-flow clients with isolated Agent Wallets.

This test uses Hermes' actual _maybe_run_device_flow implementation, but
approves each device code through a viem signer and an isolated staging vault
session. It never targets production.
"""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx

sys.path.insert(0, "/home/ubuntu/.hermes/hermes-agent")
from tools.mcp_oauth import HermesTokenStorage, _maybe_run_device_flow  # noqa: E402

BASE = os.environ.get("BASE", "http://localhost:3901").rstrip("/")
if "localhost" not in BASE and "127.0.0.1" not in BASE:
    raise SystemExit(f"REFUSED: L2 E2E must run against staging, got {BASE}")

API_DIR = Path("/home/ubuntu/arc-dex-api")
SESSION_STORE = API_DIR / "data-staging/session-keys.json"
TOKEN_STORE = API_DIR / "data-staging/oauth-tokens.json"

# These are the two active mock MSCA sessions seeded in staging.
AGENTS = [
    ("hermes-l2-agent-1", "0x3333333333333333333333333333333333333333", "arx_vs_test_agent1"),
    ("hermes-l2-agent-2", "0x4444444444444444444444444444444444444444", "arx_vs_test_agent2"),
]

NODE_APPROVER = r"""
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
(async () => {
  const [userCode, mscaWallet, vaultToken] = process.argv.slice(1);
  const account = privateKeyToAccount(generatePrivateKey());
  const base = process.env.BASE;
  const messageResponse = await fetch(`${base}/api/auth/device/message`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ address: account.address, user_code: userCode }),
  });
  if (!messageResponse.ok) throw new Error(`device/message ${messageResponse.status}`);
  const messageData = await messageResponse.json();
  const signature = await account.signMessage({ message: messageData.message });
  const approveResponse = await fetch(`${base}/api/auth/device/approve`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      address: account.address,
      message: messageData.message,
      signature,
      user_code: userCode,
      mscaWalletAddress: mscaWallet,
      mscaSessionToken: vaultToken,
      approve: true,
    }),
  });
  const result = await approveResponse.json();
  if (!approveResponse.ok || result.ok !== true) throw new Error(`device/approve ${approveResponse.status}: ${JSON.stringify(result)}`);
  process.stdout.write(JSON.stringify({ address: account.address }));
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
"""


def run_check(name, condition, detail=""):
    suffix = f" :: {detail}" if detail else ""
    print(f"{'PASS' if condition else 'FAIL'} {name}{suffix}")
    return condition


def run_one_agent(server_name, msca_wallet, vault_token):
    """Run one actual Hermes flow and return its token plus approving EOA."""
    holder = {}
    approver_result = {}

    def approve_when_ready():
        deadline = time.time() + 45
        while time.time() < deadline and not holder.get("code"):
            time.sleep(0.2)
        if not holder.get("code"):
            approver_result["error"] = "timed out waiting for device code"
            return
        env = dict(os.environ, BASE=BASE)
        completed = subprocess.run(
            ["node", "-e", NODE_APPROVER, holder["code"], msca_wallet, vault_token],
            cwd=API_DIR,
            env=env,
            capture_output=True,
            text=True,
            timeout=45,
        )
        if completed.returncode != 0:
            approver_result["error"] = completed.stderr.strip() or "approver failed"
            return
        try:
            approver_result.update(json.loads(completed.stdout))
        except json.JSONDecodeError:
            approver_result["error"] = f"invalid approver output: {completed.stdout[:120]}"

    with tempfile.TemporaryDirectory(prefix=f"hermes-{server_name}-") as hermes_home:
        storage = HermesTokenStorage(server_name, hermes_home=hermes_home)
        approver = threading.Thread(target=approve_when_ready, daemon=True)
        approver.start()
        output = io.StringIO()
        result = {}

        def run_flow():
            with contextlib.redirect_stdout(output):
                try:
                    result["ok"] = _maybe_run_device_flow(
                        server_name,
                        f"{BASE}/mcp",
                        {"timeout": 180, "device_flow": "device", "client_name": server_name},
                        storage,
                    )
                except Exception as error:  # noqa: BLE001
                    result["error"] = str(error)

        flow = threading.Thread(target=run_flow)
        flow.start()
        while flow.is_alive():
            text = output.getvalue()
            marker = "Device code: "
            marker_index = text.find(marker)
            if marker_index >= 0 and not holder.get("code"):
                holder["code"] = text[marker_index + len(marker):].strip().splitlines()[0].strip()
            time.sleep(0.2)
        flow.join()
        approver.join(timeout=60)

        tokens = {}
        token_path = Path(storage._tokens_path())
        if token_path.exists():
            tokens = json.loads(token_path.read_text())
        return {
            "server_name": server_name,
            "result": result,
            "output": output.getvalue(),
            "approver": approver_result,
            "tokens": tokens,
        }


def mcp_probe(token):
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    initialize = {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "hermes-l2", "version": "1"},
        },
    }
    first = httpx.post(f"{BASE}/mcp", headers=headers, json=initialize, timeout=30)
    session_id = first.headers.get("mcp-session-id", "")
    next_headers = dict(headers)
    if session_id:
        next_headers["mcp-session-id"] = session_id
    second = httpx.post(
        f"{BASE}/mcp",
        headers=next_headers,
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        timeout=30,
    )
    return first.status_code, second.status_code, second.text


def main():
    first = run_one_agent(*AGENTS[0])
    second = run_one_agent(*AGENTS[1])
    passed = True

    for label, item in (("agent1", first), ("agent2", second)):
        ok = item["result"].get("ok") is True and "error" not in item["result"]
        passed &= run_check(f"{label} Hermes device flow", ok, item["result"].get("error", ""))
        passed &= run_check(
            f"{label} approval succeeded",
            "address" in item["approver"] and "error" not in item["approver"],
            item["approver"].get("error", ""),
        )
        passed &= run_check(
            f"{label} temporary Hermes token cache",
            item["tokens"].get("access_token", "").startswith("arx_at_")
            and item["tokens"].get("refresh_token", "").startswith("arx_rt_"),
        )

    if not passed:
        print("\nL2 aborted before isolation checks")
        return 1

    # Find the two EOA identities created by the independent viem approvers.
    session_data = json.loads(SESSION_STORE.read_text())
    bindings = session_data.get("agentBindings", {})
    addresses = [first["approver"]["address"].lower(), second["approver"]["address"].lower()]
    found = []
    for address in addresses:
        matches = [(key, value) for key, value in bindings.items() if key.endswith("|" + address)]
        found.append(matches[-1] if matches else None)

    passed &= run_check("agent1 binding exists", found[0] is not None)
    passed &= run_check("agent2 binding exists", found[1] is not None)
    if found[0] and found[1]:
        key1, binding1 = found[0]
        key2, binding2 = found[1]
        passed &= run_check("agent bindings use distinct client IDs", key1 != key2, f"{key1} vs {key2}")
        passed &= run_check(
            "agent1 wallet remains selected",
            binding1.get("walletAddress", "").lower() == AGENTS[0][1].lower(),
            binding1.get("walletAddress", ""),
        )
        passed &= run_check(
            "agent2 wallet remains selected",
            binding2.get("walletAddress", "").lower() == AGENTS[1][1].lower(),
            binding2.get("walletAddress", ""),
        )
        passed &= run_check(
            "wallets are isolated",
            binding1.get("walletAddress", "").lower() != binding2.get("walletAddress", "").lower(),
        )

    oauth_tokens = json.loads(TOKEN_STORE.read_text()).get("tokens", {})
    for label, item, expected_wallet in (
        ("agent1", first, AGENTS[0][1]),
        ("agent2", second, AGENTS[1][1]),
    ):
        token = item["tokens"].get("access_token", "")
        record = oauth_tokens.get(token, {})
        passed &= run_check(
            f"{label} OAuth token locks its MSCA",
            record.get("mscaWalletAddress", "").lower() == expected_wallet.lower(),
            record.get("mscaWalletAddress", ""),
        )
        init_status, tools_status, tools_body = mcp_probe(token)
        passed &= run_check(f"{label} MCP initialize", init_status == 200, str(init_status))
        passed &= run_check(
            f"{label} MCP tools/list",
            tools_status == 200 and '"tools"' in tools_body,
            str(tools_status),
        )

    print("\nL2 TWO-AGENT ALL PASS" if passed else "\nL2 TWO-AGENT FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
