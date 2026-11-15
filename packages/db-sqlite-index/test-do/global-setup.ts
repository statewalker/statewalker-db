import { fileURLToPath } from "node:url";
import { celldDevSetup } from "@statewalker/db-tests/celld-dev";

/** Start `celld dev` on test-do/ with a clean state; stop exactly that process afterwards. */
export default celldDevSetup(fileURLToPath(new URL(".", import.meta.url)));
