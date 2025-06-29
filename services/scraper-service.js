const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
const logger = require("../utils/logger");
const { log } = require("winston");

// function to ensure output folder exists
const outputDir = path.join(__dirname, '../output');
if(!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
  logger.info('output folder created');
} else {
  logger.info('output folder already exists');
}

const csvFilePath = path.join(outputDir, 'scraper-output.csv');

const csvWriter = createCsvWriter({
  path: csvFilePath,
  header: [
    { id: "title", title: "Title" },
    { id: "aura", title: "Aura" },
    { id: "category", title: "Category" },
    { id: "description", title: "Description" },
    { id: "latitude", title: "Latitude" },
    { id: "longitude", title: "Longitude" },
    { id: "price", title: "Price" },
    { id: "images", title: "Images" },
  ],
});

// this function extracts sites data and save to a CSV file
exports.scrapeAndSaveToCSV = async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  const baseUrl = "https://whc.unesco.org/en/list/";
  await page.goto(baseUrl);

  logger.info("collecting site links....");
  const siteLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("div#content a"))
      .map((link) => link.href)
      .filter((href) => href.includes("/en/list"));
  });

  const uniqueLinks = [...new Set(siteLinks)];
  const scrapedData = [];

  for (const link of uniqueLinks) {
    try {
      await page.goto(link, { waitUntil: "domcontentloaded" });

      const siteData = await page.evaluate(() => {
        const title = document.querySelector("h2")?.innerText || " ";
        const description =
          document.querySelector("description p")?.innerText || " ";
        const images = Array.from(document.querySelectorAll(" .gallery img"))
          .slice(0, 6)
          .map((img) => img.src);

        return {
          title,
          description: description.split(". ").slice(0, 2).join(". ") + ". ",
          images: images.join(". "),
        };
      });

      scrapedData.push({
        title: siteData.title,
        aura: 400,
        category: "historic",
        description: siteData.description,
        latitude: "",
        longitude: "",
        price: "NONE",
        images: siteData.images,
      });

      logger.info(`scraped: ${siteData.title}`);
    } catch (err) {
      logger.error(`failed on ${link}: ${err.message}`);
    }
  }

  await browser.close();

  await csvWriter.writeRecords(scrapedData);
  logger.info("csv written successfully..");
};
