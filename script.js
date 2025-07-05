const puppeteer = require("puppeteer");
const winston = require("winston");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
const axios = require("axios");
const path = require("path");
require("dotenv").config();

// Logger setup
const logger = winston.createLogger({
  level: "debug",
  format: winston.format.simple(),
  transports: [new winston.transports.Console()],
});

const csvFilePath = path.join(__dirname, "unesco_sites.csv");

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

const summarizeText = async (longText) => {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

  if (!longText || longText.trim().length < 20) {
    logger.warn("Description too short or empty. Skipping Gemini summarization.");
    return longText || "No description available.";
  }

  const prompt = `Summarize this UNESCO description in exactly 2 simple sentences:\n\n${longText}`;

  try {
    const response = await axios.post(url, {
      contents: [{ parts: [{ text: prompt }] }],
    }, {
      headers: { "Content-Type": "application/json" },
    });

    const output = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return output?.trim() || longText.split(".").slice(0, 2).join(". ") + ".";
  } catch (error) {
    logger.error(`Gemini API Error: ${error.message}`);
    return longText.split(".").slice(0, 2).join(". ") + ".";
  }
};

const gotoWithRetries = async (page, url, options = {}, maxRetries = 3) => {
  for (let attempts = 0; attempts < maxRetries; attempts++) {
    try {
      await page.goto(url, options);
      return;
    } catch (error) {
      logger.warn(`Navigation failed (attempt ${attempts + 1}): ${error.message}`);
      if (attempts + 1 === maxRetries) throw error;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
};

(async () => {
  logger.info("Starting UNESCO scraper...");

  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  try {
    logger.info("Loading UNESCO list page...");
    await gotoWithRetries(page, "https://whc.unesco.org/en/list", {
      waitUntil: "networkidle2",
      timeout: 90000,
    });
  } catch (error) {
    logger.error(`Failed to load the UNESCO list page: ${error.stack}`);
    await browser.close();
    process.exit(1);
  }

  try {
    const siteLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".list_site a"))
        .map((a) => a.href.startsWith("http") ? a.href : `https://whc.unesco.org${a.getAttribute("href")}`)
        .filter((href) => !href.includes("#"))
    );

    logger.info(`Found ${siteLinks.length} site links.`);

    if (!siteLinks.length) throw new Error("No site links found, aborting.");

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
          const getText = (selector) => document.querySelector(selector)?.innerText.trim() || "";
          const getImage = (selector) => document.querySelector(selector)?.getAttribute("src") || "";

          const title = getText("h2.title") || getText("#content h2");
          const descElement = document.querySelector("div#content-desktop p") || document.querySelector("#content p");
          const descriptionFull = descElement?.innerText.trim() || "";
          const coordsText = getText(".latlong");
          const image = getImage(".illustration img");

          return { title, descriptionFull, coordsText, image };
        });

        if (!siteData.title || !siteData.descriptionFull) {
          logger.warn("Missing title or description. Skipping site.");
          continue;
        }

        let latitude = "";
        let longitude = "";
        const coordsMatch = siteData.coordsText.match(/Lat: ([\d.-]+), Long: ([\d.-]+)/i);
        if (coordsMatch) {
          [latitude, longitude] = [coordsMatch[1], coordsMatch[2]];
        }

        const fullImageUrl = siteData.image.startsWith("http")
          ? siteData.image
          : siteData.image ? `https://whc.unesco.org${siteData.image}` : "";

        const summary = await summarizeText(siteData.descriptionFull);

        data.push({
          title: siteData.title,
          aura: 400,
          category: "historic",
          description: summary,
          latitude,
          longitude,
          price: "N/A",
          images: fullImageUrl,
        });
      } catch (err) {
        logger.warn(`Failed to scrape ${url}: ${err.message}`);
      }
    }

    await sitePage.close();

    logger.info(` Records collected: ${data.length}`);
    if (data.length) {
      await csvWriter.writeRecords(data);
      logger.info(`Scraping complete. Data saved to ${csvFilePath}`);
    } else {
      logger.warn("No data collected. Skipping CSV creation.");
    }
  } catch (error) {
    logger.error(`Scraping error: ${error.stack}`);
  } finally {
    await browser.close();
  }
})();
          
