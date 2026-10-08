#!/usr/bin/env bun
import { start } from "./commands/start";
import { stop, stopAll } from "./commands/stop";
import { clear } from "./commands/clear";
import { status } from "./commands/status";
import { telegram } from "./commands/telegram";
import { slack } from "./commands/slack";
import { send } from "./commands/send";
import { runAgent, agentPair, agentStatus, agentUnpair } from "./agent/client";

const args = process.argv.slice(2);
const command = args[0];

if (command === "--stop-all") {
  stopAll();
} else if (command === "--stop") {
  stop();
} else if (command === "--clear") {
  clear();
} else if (command === "start") {
  start(args.slice(1));
} else if (command === "status") {
  status(args.slice(1));
} else if (command === "telegram") {
  telegram();
} else if (command === "slack") {
  slack();
} else if (command === "send") {
  send(args.slice(1));
} else if (command === "agent") {
  const sub = args[1];
  if (sub === "pair") agentPair(args.slice(2));
  else if (sub === "status") agentStatus();
  else if (sub === "unpair") agentUnpair();
  else runAgent();
} else {
  start();
}
