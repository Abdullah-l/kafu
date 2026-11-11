import { connect } from "node:net";
import { readRunToken } from "./run-token";

const name = process.argv[2] ?? "";

function fail(message: string): never {
  process.stderr.write(`kafu MCP bridge (${name}): ${message}\n`);
  process.exit(1);
}

const token = await readRunToken().catch((err) => fail(`no run token: ${err instanceof Error ? err.message : err}`));
const socket = connect(process.env.KAFU_MCP_SOCKET || "/run/kafu-mcp.sock");
socket.on("error", (err) => fail(`kafu isn't reachable: ${err.message}`));
socket.on("connect", () => {
  socket.write(JSON.stringify({ token, server: name }) + "\n");
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on("close", () => process.exit(0));
process.stdin.on("end", () => socket.end());
