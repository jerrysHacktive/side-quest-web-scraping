const puppeteer = require("puppeteer-extra"); // Puppeteer is used for controlling a headless browser
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const randomUseragent = require("random-useragent");
const playSound = require("play-sound");
const winston = require("winston"); // Winston is used for logging
const createCsvWriter = require("csv-writer").createObjectCsvWriter; // CSV writer library
const fs = require("fs"); // Used to read/write files
const path = require("path"); // Used to build file paths
const axios = require("axios"); // Axios is used to make HTTP requests (e.g., to Gemini)
require("dotenv").config(); // Loads environment variables from .env file

puppeteer.use(StealthPlugin()); // Apply stealth plugin
const player = playSound();

TIMEOUT = 90000; // Default timeout for requests to UNESCO site
HEADLESS = false; // Whether the scraper should run in headless mode
MODEL = "gemini-2.5-flash-lite-preview-06-17"; // The model to use for summarizing the description
VERSION = "v1beta"; // The version of the Google Cloud api - may have to be changed with different models

// Logger setup
const logger = winston.createLogger({
  level: "debug",
  format: winston.format.simple(),
  transports: [new winston.transports.Console()],
});

// Path to save the CSV file
const csvFilePath = path.join(__dirname, "unesco_sites.csv");

// CSV writer configuration with headers
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
    { id: "link", title: "Link" },
  ],
  append: true,
});

// This function uses Google's Gemini API to summarize long text into 2 sentences
const summarizeText = async (longText) => {
  const url = `https://generativelanguage.googleapis.com/${VERSION}/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  if (!longText || longText.trim().length < 20) {
    logger.warn("Description too short or empty. Skipping Gemini summarization.");
    return longText || "No description available.";
  }
  const prompt = `Summarize this UNESCO site description in exactly 2 simple sentences:\n\n${longText}`;
  try {
    const response = await axios.post(
      url,
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { "Content-Type": "application/json" } }
    );
    const output = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return output?.trim() || longText.split(".").slice(0, 2).join(". ") + ".";
  } catch (error) {
    logger.error(`Gemini API Error: ${error.message}`);
    logger.error(error);
    process.exit(1); // Exit immediately on Gemini API failure
  }
};

// Attempts to navigate to a URL with retries in case of network errors
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

// Converts a DMS string (e.g., N34 23 47.1 E64 30 57.2) to decimal latitude and longitude
const dmsToDD = (dms) => {
  const toDD = (deg, min, sec) => {
    return Number.parseFloat(deg) + Number.parseFloat(min) / 60 + Number.parseFloat(sec) / 3600;
  };
  if (!dms) {
    logger.warn(`Failed to parse DMS string: "${dms}"`);
    return [NaN, NaN];
  }
  let parts = dms.split(" ");
  let partsLat = parts.slice(0, 3);
  let partsLong = parts.slice(3);
  let latDeg = partsLat[0].split(/N|S/, 2)[1];
  let lat = toDD(latDeg, partsLat[1], partsLat[2]);
  if (partsLat[0][0] == "S") lat *= -1;
  let longDeg = partsLong[0].split(/E|W/, 2)[1];
  let long = toDD(longDeg, partsLong[1], partsLong[2]);
  if (partsLong[0][0] == "W") long *= -1;
  return [lat, long];
};


// Main function to run the scraper
(async () => {
  logger.info("Starting UNESCO scraper...");

  // Load previously scraped links from CSV
  const scrapedLinks = new Set();
  if (fs.existsSync(csvFilePath)) {
    const rawData = fs.readFileSync(csvFilePath, "utf8");
    const lines = rawData.split("\n").slice(1); // Skip header
    for (const line of lines) {
      const cols = line.split(",");
      const link = cols[cols.length - 1]?.trim();
      if (link) scrapedLinks.add(link);
    }
  }

  const browser = await puppeteer.launch({ headless: HEADLESS, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setUserAgent(randomUseragent.getRandom());

  try {
    logger.info("Loading UNESCO list page...");
    // Navigate to the main list of UNESCO sites
    await gotoWithRetries(page, "https://whc.unesco.org/en/list", {
      waitUntil: "networkidle2",
      timeout: TIMEOUT,
    });
  } catch (error) {
    logger.error(`Failed to load the UNESCO list page: ${error.stack}`);
    await browser.close();
    process.exit(1);
  }

  try {
    // Extract all valid links to individual site pages
    const siteLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".list_site a"))
        .map((a) => (a.href.startsWith("http") ? a.href : `https://whc.unesco.org${a.getAttribute("href")}`))
        .filter((href) => !href.includes("#"))
    );

    logger.info(`Found ${siteLinks.length} site links.`);

    if (!siteLinks.length) throw new Error("No site links found, aborting.");

    const sitePage = await browser.newPage();
    await sitePage.setUserAgent(randomUseragent.getRandom());

    for (const [index, url] of siteLinks.entries()) {
      if (scrapedLinks.has(url)) {
        logger.info(`Skipping already scraped URL: ${url}`);
        continue;
      }

      logger.info(`Scraping site ${index + 1}/${siteLinks.length}: ${url}`);
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000)); // Random delay

      try {
        // Navigate to each individual site page
        await gotoWithRetries(sitePage, url, {
          waitUntil: "networkidle2",
          timeout: TIMEOUT,
        });

        let content = await sitePage.content();
        let detected = content.search("This question is for testing whether you are a human visitor and to prevent automated spam submission") !== -1;
        if (detected) {
          for (let i = 0; i < 25; i++) {
            logger.warn("!!!!!!!!!!!!!!!!!!!!!!!!");
          }
          logger.warn("⚠️ CAPTCHA detected! Please solve in the browser window, and hit ENTER once complete.");
          player.play("beep.mp3");
          await new Promise((resolve) => {
            process.stdin.resume();
            process.stdin.once("data", () => {
              process.stdin.pause();
              resolve();
            });
          });
          logger.info("Continuing after manual CAPTCHA solve...");
          // give site a moment to register the solve
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }

        // Extract relevant data from the site page
        const siteData = await sitePage.evaluate(() => {
          const getText = (selector) => document.querySelector(selector)?.innerText.trim() || "";
          const getImage = (selector) => document.querySelector(selector)?.getAttribute("src") || "";

          const title = getText("h1.title") || getText("#content h1");
          const descElement =
            document.querySelector("div#contentdes_en div.rich-text p") ||
            document.querySelector("div#contentdes_en div.rich-text") ||
            document.querySelector("div.tab-content div.rich-text p");
          const descriptionFull = descElement?.innerText.trim() || "";
          const coordsElements = document.querySelectorAll("div.mt-3.small.text-muted div");
          const coordsText = coordsElements[coordsElements.length - 1]?.innerText.trim() || "";

          // Collect images
          const images = [];
          let topImage = getImage("img.w-100.border");
          if (topImage) images.push(topImage);

          return { title, descriptionFull, coordsText, images, siteText: document.documentElement.innerHTML };
        });

        // Exit immediately if required fields are missing
        if (!siteData.title || !siteData.descriptionFull) {
          logger.error("Missing title or description. Exiting.");
          logger.info(siteData.title);
          logger.info(siteData.descriptionFull);
          logger.info(siteData.siteText);
          process.exit(1);
        }

        // Extract latitude and longitude from coordinates text
        let [latitude, longitude] = dmsToDD(siteData.coordsText);

        // Summarize the description using Gemini
        const summary = await summarizeText(siteData.descriptionFull);

        // Add site data to the dataset array
        let info = {
          title: siteData.title,
          aura: 400,
          category: "historic",
          description: summary,
          latitude,
          longitude,
          price: "N/A",
          images: siteData.images,
          link: url,
        };

        // Log and write to CSV
        console.log(info);
        await csvWriter.writeRecords([info]);
        logger.info(`Saved: ${siteData.title}`);
      } catch (err) {
        logger.warn(`Failed to scrape ${url}: ${err.message}`);
      }
    }

    await sitePage.close();
  } catch (error) {
    logger.error(`Scraping error: ${error.stack}`);
  } finally {
    // Close the browser no matter what
    await browser.close();
  }
})();