const puppeteer = require("puppeteer");
const winston = require("winston");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
const axios = require("axios");
require("dotenv").config();

// Logger setup
const logger = winston.createLogger({
  level: "info",
  format: winston.format.simple(),
  transports: [new winston.transports.Console()],
});

// CSV writer config
const csvWriter = createCsvWriter({
  path: "unesco_sites.csv",
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

// Summarize text using Gemini API (text-bison-001 model)
const summarizeText = async (longText) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/text-bison-001:generateText?key=${process.env.GEMINI_API_KEY}`;

  try {
    const response = await axios.post(
      url,
      {
        prompt: {
          text: `Summarize this UNESCO description in exactly 2 simple sentences:\n\n${longText}`,
        },
        temperature: 0.3,
        maxOutputTokens: 100,
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    const summary = response.data?.candidates?.[0]?.output;
    return summary?.trim() || longText.split(".").slice(0, 2).join(". ") + ".";
  } catch (error) {
    logger.error(
      `Gemini API Error: ${error.response?.status} ${
        error.response?.data?.error?.message || error.message
      }`
    );
    return longText.split(".").slice(0, 2).join(". ") + ".";
  }
};

// Helper: retry navigation
async function gotoWithRetries(page, url, options = {}, maxRetries = 3) {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      await page.goto(url, options);
      return;
    } catch (error) {
      attempts++;
      logger.warn(`Navigation failed (attempt ${attempts}): ${error.message}`);
      if (attempts === maxRetries) throw error;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// Main scraping function
(async () => {
  logger.info("Starting UNESCO scraper...");

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();

  try {
    logger.info("Loading UNESCO list page...");
    await gotoWithRetries(page, "https://whc.unesco.org/en/list", {
      waitUntil: "networkidle2",
      timeout: 90000,
    });
    logger.info("Successfully loaded the UNESCO list page.");
  } catch (error) {
    logger.error(`Failed to load the UNESCO list page: ${error.stack}`);
    await browser.close();
    process.exit(1);
  }

  try {
    const siteLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".list_site a"))
        .map((a) =>
          a.href.startsWith("http")
            ? a.href
            : `https://whc.unesco.org${a.getAttribute("href")}`
        )
        .filter((href) => !href.includes("#"))
    );

    logger.info(`Found ${siteLinks.length} site links.`);

    const data = [];
    const sitePage = await browser.newPage();

    for (const [index, url] of siteLinks.entries()) {
      logger.info(`Scraping site ${index + 1}/${siteLinks.length}: ${url}`);

      try {
        await gotoWithRetries(sitePage, url, {
          waitUntil: "networkidle2",
          timeout: 90000,
        });

        const siteData = await sitePage.evaluate(() => {
          const getText = (selector) =>
            document.querySelector(selector)?.innerText.trim() || " ";
          const getImage = (selector) =>
            document.querySelector(selector)?.src || " ";

          const title = getText("h2");
          const descriptionFull = getText("div#content p");
          const coordsText = getText(".latlong");
          const image = getImage(".illustration img");

          return { title, descriptionFull, coordsText, image };
        });

        let latitude = " ";
        let longitude = " ";
        const coordsMatch = siteData.coordsText.match(
          /lat: ([\d.-]+), long: ([\d.-]+)/
        );
        if (coordsMatch) {
          [latitude, longitude] = [coordsMatch[1], coordsMatch[2]];
        }

        const summary = await summarizeText(siteData.descriptionFull);

        data.push({
          title: siteData.title,
          aura: 400,
          category: "historic",
          description: summary,
          latitude,
          longitude,
          price: "N/A",
          images: siteData.image,
        });
      } catch (err) {
        logger.warn(`Failed to scrape ${url}: ${err.message}`);
      }
    }

    await sitePage.close();

    await csvWriter.writeRecords(data);
    logger.info("Scraping complete. Data saved to unesco_sites.csv");
  } catch (error) {
    logger.error(`Scraping error: ${error.stack}`);
  } finally {
    await browser.close();
  }
})();
