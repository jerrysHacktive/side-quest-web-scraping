const express = require("express");
const app = express();
require("dotenv").config();
const logger = require("./utils/logger");
const scrapeRoute = require("./route/scrape-route");


app.use(express.json());

const API_PORT = process.env.API_PORT || 4000;

app.use("/api/scrape", scrapeRoute);

// start your server
app.listen(API_PORT, () => {
  logger.info(`server is running on port ${API_PORT}`);
});
