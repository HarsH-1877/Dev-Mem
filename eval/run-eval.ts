#!/usr/bin/env node
import { main } from "./harness/index.js";

main().catch(err => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
