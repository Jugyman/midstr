const { createApp } = require("./app");
const logger = require("./utils/logger");

async function main() {
  try {
    const app = createApp();
    app.start();
    logger.info("MIDSTR bot started.");
  } catch (error) {
    logger.error("Fatal startup error:", error);
    process.exit(1);
  }
}

main();