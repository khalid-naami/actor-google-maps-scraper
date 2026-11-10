import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { dismissConsentDialog, extractPlaceDetails, parseCoordinatesFromUrl, parseRating, parseReviewsCount, cleanPhone } from './extractors.js';

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const {
        searchStringsArray = ['cafes in London'],
        maxCrawledPlacesPerSearch = 40,
        language = 'en',
        includeOpeningHours = true,
        proxyConfiguration,
    } = input;

    if (!Array.isArray(searchStringsArray) || searchStringsArray.length === 0) {
        log.warning('No search queries provided in searchStringsArray. Nothing to scrape.');
        await Actor.exit();
    }

    log.info(`Starting Google Maps Leads Scraper for ${searchStringsArray.length} queries (limit: ${maxCrawledPlacesPerSearch} places/query)`);

    // Setup Proxy
    let proxyUrl = undefined;
    if (proxyConfiguration) {
        const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
        if (proxyConfig) {
            proxyUrl = await proxyConfig.newUrl();
            log.info('Configured proxy successfully');
        }
    }

    // Launch Browser
    const launchOptions = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
        ],
    };
    if (proxyUrl) {
        launchOptions.proxy = { server: proxyUrl };
    }

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        locale: language,
        viewport: { width: 1280, height: 900 },
    });

    let totalPlacesScraped = 0;
    let placesWithWebsite = 0;
    let placesWithPhone = 0;

    for (const query of searchStringsArray) {
        log.info(`Searching Google Maps for: "${query}"`);
        const page = await context.newPage();

        try {
            const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}/?hl=${encodeURIComponent(language)}`;
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

            // Handle Cookie Consent
            await dismissConsentDialog(page);

            // Wait a brief moment for dynamic feed or direct redirect
            await page.waitForTimeout(3000);

            const currentUrl = page.url();

            // Case 1: Direct redirect to a single place
            if (currentUrl.includes('/maps/place/')) {
                log.info(`Direct match found for single place: ${currentUrl}`);
                const details = await extractPlaceDetails(page, currentUrl);
                details.searchQuery = query;

                await Actor.pushData(details);
                totalPlacesScraped++;
                if (details.website) placesWithWebsite++;
                if (details.phone) placesWithPhone++;
                await page.close();
                continue;
            }

            // Case 2: Feed of multiple listings
            const feedLocator = page.locator('div[role="feed"]').first();
            const feedExists = await feedLocator.isVisible({ timeout: 5000 }).catch(() => false);

            if (!feedExists) {
                log.warning(`No feed or places found for query "${query}".`);
                await page.close();
                continue;
            }

            const visitedUrls = new Set();
            let placesExtractedForQuery = 0;
            let scrollRetries = 0;

            while (placesExtractedForQuery < maxCrawledPlacesPerSearch && scrollRetries < 5) {
                // Find all place link elements in feed
                const placeLinks = await page.locator('div[role="feed"] a[href*="/maps/place/"]').all();
                let newlyFound = 0;

                for (const link of placeLinks) {
                    if (placesExtractedForQuery >= maxCrawledPlacesPerSearch) break;

                    const href = await link.getAttribute('href').catch(() => null);
                    if (!href || visitedUrls.has(href)) continue;

                    visitedUrls.add(href);
                    newlyFound++;

                    try {
                        // Click link to open detail pane
                        await link.scrollIntoViewIfNeeded().catch(() => {});
                        await link.click({ timeout: 3000 }).catch(() => {});
                        await page.waitForTimeout(1500);

                        // Extract data from details panel
                        const details = await extractPlaceDetails(page, href);
                        details.searchQuery = query;

                        if (details.title) {
                            await Actor.pushData(details);
                            placesExtractedForQuery++;
                            totalPlacesScraped++;
                            if (details.website) placesWithWebsite++;
                            if (details.phone) placesWithPhone++;

                            log.info(`[${placesExtractedForQuery}/${maxCrawledPlacesPerSearch}] Extracted: "${details.title}" | Tel: ${details.phone || 'N/A'} | Web: ${details.website || 'N/A'}`);
                        }
                    } catch (itemErr) {
                        log.debug(`Failed extracting item detail: ${itemErr.message}`);
                    }
                }

                // Scroll feed to trigger lazy-loading of more items
                if (placesExtractedForQuery < maxCrawledPlacesPerSearch) {
                    const scrollSuccess = await feedLocator.evaluate((el) => {
                        const prevScroll = el.scrollTop;
                        el.scrollBy(0, 1000);
                        return el.scrollTop > prevScroll;
                    }).catch(() => false);

                    await page.waitForTimeout(2000);

                    // Check for "end of list" banner
                    const endBanner = page.locator('text="You\'ve reached the end of the list"').first();
                    const isEnd = await endBanner.isVisible({ timeout: 1000 }).catch(() => false);

                    if (isEnd || (!scrollSuccess && newlyFound === 0)) {
                        scrollRetries++;
                        log.debug(`Scroll stalled or reached end of list (${scrollRetries}/5)`);
                    } else {
                        scrollRetries = 0;
                    }
                }
            }

            log.info(`Completed query "${query}": ${placesExtractedForQuery} places extracted.`);
        } catch (queryErr) {
            log.error(`Error processing query "${query}": ${queryErr.message}`);
        } finally {
            if (!page.isClosed()) {
                await page.close();
            }
        }
    }

    await browser.close();

    // Save final executive summary
    const summary = {
        totalQueries: searchStringsArray.length,
        totalPlacesScraped,
        placesWithWebsite,
        placesWithPhone,
        status: 'SUCCEEDED',
        scrapedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', summary);
    log.info(`Scraping finished successfully! Total places scraped: ${totalPlacesScraped}`);

} catch (err) {
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message });
} finally {
    await Actor.exit();
}
