import { createAppServer } from "../src/server.mjs";
import { waitUntil } from "@vercel/functions";

// Vercel's Node runtime accepts a Node HTTP server, including its upgrade
// handler. One deployment serves the private API and /ws/esp32 voice bridge.
export default createAppServer({ waitUntil });
