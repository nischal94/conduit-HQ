#!/usr/bin/env node
import { isSupportedNode, UNSUPPORTED_NODE_LINE } from "./node-support.js";

if (!isSupportedNode(process.versions.node)) {
  process.stderr.write(UNSUPPORTED_NODE_LINE(process.versions.node));
  process.exit(1);
}
await import("./cli.js");
