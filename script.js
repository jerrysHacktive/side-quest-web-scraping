const puppeteer = require("puppeteer"); // Puppeteer is used for controlling a headless browser
const winston = require("winston"); // Winston is used for logging
const createCsvWriter = require("csv-writer").createObjectCsvWriter; // CSV writer library
const axios = require("axios"); // Axios is used to make HTTP requests (e.g., to Gemini)
const path = require("path"); // Used to build file paths
require("dotenv").config(); // Loads environment variables from .env file

// Logger setup
const logger = winston.createLogger({
  level: "debug", // Set log level to debug
  format: winston.format.simple(), // Use simple log formatting
  transports: [new winston.transports.Console()], // Output logs to the console
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
  ],
});

// This function uses Google's Gemini API to summarize long text into 2 sentences
const summarizeText = async (longText) => {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

  // If the text is too short, skip summarization
  if (!longText || longText.trim().length < 20) {
    logger.warn("Description too short or empty. Skipping Gemini summarization.");
    return longText || "No description available.";
  }

  // Prompt to send to Gemini
  const prompt = `Summarize this UNESCO description in exactly 2 simple sentences:\n\n${longText}`;

  try {
    // Send POST request to Gemini API
    const response = await axios.post(
      url,
      {
        contents: [{ parts: [{ text: prompt }] }],
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    // Try to extract the summarized text
    const output = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return output?.trim() || longText.split(".").slice(0, 2).join(". ") + ".";
  } catch (error) {
    // Log and return fallback summary if Gemini API fails
    logger.error(`Gemini API Error: ${error.message}`);
    return longText.split(".").slice(0, 2).join(". ") + ".";
  }
};

// Attempts to navigate to a URL with retries in case of network errors
const gotoWithRetries = async (page, url, options = {}, maxRetries = 3) => {
  for (let attempts = 0; attempts < maxRetries; attempts++) {
    try {
      await page.goto(url, options); // Try navigating to the URL
      return;
    } catch (error) {
      // Log each failed attempt
      logger.warn(`Navigation failed (attempt ${attempts + 1}): ${error.message}`);
      if (attempts + 1 === maxRetries) throw error; // Throw error if max retries reached
      await new Promise((r) => setTimeout(r, 2000)); // Wait before retrying
    }
  }
};

// Main function to run the scraper
(async () => {
  logger.info("Starting UNESCO scraper...");

  // Launch Puppeteer in headless mode
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage(); // Open a new tab

  try {
    logger.info("Loading UNESCO list page...");
    // Navigate to the main list of UNESCO sites
    await gotoWithRetries(page, "https://whc.unesco.org/en/list", {
      waitUntil: "networkidle2",
      timeout: 90000,
    });
  } catch (error) {
    // If initial navigation fails, log error and exit
    logger.error(`Failed to load the UNESCO list page: ${error.stack}`);
    await browser.close();
    process.exit(1);
  }

  try {
    // Extract all valid links to individual site pages
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

    if (!siteLinks.length) throw new Error("No site links found, aborting.");

    const data = [];
    const sitePage = await browser.newPage(); // Open another tab to scrape each site

    for (const [index, url] of siteLinks.entries()) {
      logger.info(`Scraping site ${index + 1}/${siteLinks.length}: ${url}`);

      try {
        // Navigate to each individual site page
        await gotoWithRetries(sitePage, url, {
          waitUntil: "networkidle2",
          timeout: 90000,
        });

        // Extract relevant data from the site page
        const siteData = await sitePage.evaluate(() => {
          const getText = (selector) => document.querySelector(selector)?.innerText.trim() || "";
          const getImage = (selector) => document.querySelector(selector)?.getAttribute("src") || "";

          const title = getText("h2.title") || getText("#content h2");
          const descElement =
            document.querySelector("div#content-desktop p") ||
            document.querySelector("#content p");
          const descriptionFull = descElement?.innerText.trim() || "";
          const coordsText = getText(".latlong");
          const image = getImage(".illustration img");

          return { title, descriptionFull, coordsText, image };
        });

        // Skip if critical fields are missing
        if (!siteData.title || !siteData.descriptionFull) {
          logger.warn("Missing title or description. Skipping site.");
          continue;
        }

        // Extract latitude and longitude from coordinates text
        let latitude = "";
        let longitude = "";
        const coordsMatch = siteData.coordsText.match(/Lat: ([\d.-]+), Long: ([\d.-]+)/i);
        if (coordsMatch) {
          [latitude, longitude] = [coordsMatch[1], coordsMatch[2]];
        }

        // Make sure image has full URL
        const fullImageUrl = siteData.image.startsWith("http")
          ? siteData.image
          : siteData.image
          ? `https://whc.unesco.org${siteData.image}`
          : "";

        // Summarize the description using Gemini
        const summary = await summarizeText(siteData.descriptionFull);

        // Add site data to the dataset array
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
        // Log any per-site scraping errors but continue
        logger.warn(`Failed to scrape ${url}: ${err.message}`);
      }
    }

    await sitePage.close(); // Close the second tab

    logger.info(`Records collected: ${data.length}`);

    if (data.length) {
      // Save the collected data to a CSV file
      await csvWriter.writeRecords(data);
      logger.info(`Scraping complete. Data saved to ${csvFilePath}`);
    } else {
      logger.warn("No data collected. Skipping CSV creation.");
    }
  } catch (error) {
    // Log any global scraping error
    logger.error(`Scraping error: ${error.stack}`);
  } finally {
    // Close the browser no matter what
    await browser.close();
  }
})();
