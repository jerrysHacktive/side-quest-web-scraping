const express = require("express");
const router = express.Router();
const scrapeController = require("../controller/scrape-controller");

//route to run scraping script
router.get("/", scrapeController.scrapeSites);

module.exports = router;
