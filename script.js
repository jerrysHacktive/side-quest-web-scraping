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

// path for CSV file
const csvFilePath = path.join(__dirname, "unesco_sites.csv");

// CSV writer config
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

// Gemini API summary using gemini-pro
const summarizeText = async (longText) => {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

  if (!longText || longText.trim().length < 20) {
    logger.warn(
      "Description too short or empty. Skipping Gemini summarization."
    );
    return longText || "No description available.";
  }

  const prompt = `Summarize this UNESCO description in exactly 2 simple sentences:\n\n${longText}`;

  const requestPayload = {
    contents: [
      {
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ],
  };

  logger.debug("Sending request to Gemini API...");
  logger.debug(`Gemini API URL: ${url}`);
  logger.debug(`Request payload:\n${JSON.stringify(requestPayload, null, 2)}`);

  try {
    const response = await axios.post(url, requestPayload, {
      headers: {
        "Content-Type": "application/json",
      },
    });

    logger.debug(
      `Gemini API raw response:\n${JSON.stringify(response.data, null, 2)}`
    );

    const output = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!output) {
      logger.warn("Gemini returned no summary. Using fallback.");
      return longText.split(".").slice(0, 2).join(". ") + ".";
    }

    return output.trim();
  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.error?.message || error.message;

    logger.error(`Gemini API Error ${status}: ${message}`);
    if (error.response?.data) {
      logger.debug(
        `Gemini API full error response:\n${JSON.stringify(
          error.response.data,
          null,
          2
        )}`
      );
    }

    // Fallback summary
    return longText.split(".").slice(0, 2).join(". ") + ".";
  }
};

// Retry navigation function
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

    if (!siteLinks.length) {
      throw new Error("No site links found, aborting.");
    }

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

    logger.info(`🧮 Records collected: ${data.length}`);
    if (data.length === 0) {
      logger.warn("No data collected, CSV file will not be created.");
    } else {
      for (let i = 0; i < Math.min(data.length, 3); i++) {
        logger.info(
          `Record ${i + 1} sample: ${JSON.stringify(data[i], null, 2)}`
        );
      }
      try {
        await csvWriter.writeRecords(data);
        logger.info(`Scraping complete. Data saved to ${csvFilePath}`);
      } catch (csvError) {
        logger.error("Failed to write CSV file:", csvError);
      }
    }
  } catch (error) {
    logger.error(`Scraping error: ${error.stack}`);
  } finally {
    await browser.close();
  }
})();
