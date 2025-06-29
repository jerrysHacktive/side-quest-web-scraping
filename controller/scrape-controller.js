const scraperService = require("../services/scraper-service");
const logger = require("../utils/logger");

//this functions runs when the user visits the scrape route, it calls the service layer to perform the actual scraping and CSV writing

exports.scrapeSites = async (req, res) => {
  try {
    await scraperService.scrapeAndSaveToCSV();
    res.status(200).send("scraping completed and CSV created...");
  } catch (error) {
    logger.error("error in scraping: " + error.message);
    res.status(500).send("something went wrong while scraping");
  }
};
