import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { dismissConsentDialog, extractPlaceDetails } from './extractors.js';

const LOCALE_MAP = {
    en: 'en-US',
    es: 'es-ES',
    fr: 'fr-FR',
    de: 'de-DE',
    it: 'it-IT',
    pt: 'pt-BR',
    ar: 'ar-SA',
    ja: 'ja-JP',
    ko: 'ko-KR',
    zh: 'zh-CN',
    nl: 'nl-NL',
    ru: 'ru-RU',
    tr: 'tr-TR',
    pl: 'pl-PL',
    sv: 'sv-SE',
    hi: 'hi-IN',
};

function normalizeLocale(lang) {
    if (!lang || typeof lang !== 'string') return 'en-US';
    const cleaned = lang.trim().replace('_', '-');
    const lower = cleaned.toLowerCase();
    if (LOCALE_MAP[lower]) return LOCALE_MAP[lower];
    if (/^[a-z]{2,3}-[A-Z]{2}$/i.test(cleaned)) {
        const [l, r] = cleaned.split('-');
        return `${l.toLowerCase()}-${r.toUpperCase()}`;
    }
    return 'en-US';
}

function parsePlaywrightProxy(proxyUrl) {
    if (!proxyUrl) return undefined;
    try {
        const u = new URL(proxyUrl);
        const proxy = {
            server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`,
        };
        if (u.username) proxy.username = decodeURIComponent(u.username);
        if (u.password) proxy.password = decodeURIComponent(u.password);
        return proxy;
    } catch {
        return { server: proxyUrl };
    }
}

await Actor.init();

let browser = null;

try {
    const input = (await Actor.getInput()) || {};
    const {
        searchStringsArray = ['cafes in London'],
        maxCrawledPlacesPerSearch = 40,
        language = 'en',
        includeOpeningHours = true,
        proxyConfiguration,
    } = input;

    let totalPlacesScraped = 0;
    let placesWithWebsite = 0;
    let placesWithPhone = 0;

    if (!Array.isArray(searchStringsArray) || searchStringsArray.length === 0) {
        log.warning('No search queries provided in searchStringsArray. Nothing to scrape.');
    } else {
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
            launchOptions.proxy = parsePlaywrightProxy(proxyUrl);
        }

        browser = await chromium.launch(launchOptions);

        const rawLang = (typeof language === 'string' && language.trim()) ? language.trim() : 'en';
        const safeLocale = normalizeLocale(rawLang);

        const baseContextOptions = {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 900 },
            extraHTTPHeaders: {
                'Accept-Language': `${rawLang},${safeLocale},en;q=0.9`,
            },
        };

        let context = await browser.newContext({
            ...baseContextOptions,
            locale: safeLocale,
        });

        for (const query of searchStringsArray) {
            log.info(`Searching Google Maps for: "${query}"`);
            let page;
            try {
                page = await context.newPage();
            } catch (localeErr) {
                if (localeErr.message && localeErr.message.includes('Invalid locale name')) {
                    log.warning(`Browser rejected locale "${safeLocale}", recreating context with default locale...`);
                    await context.close().catch(() => {});
                    context = await browser.newContext(baseContextOptions);
                    page = await context.newPage();
                } else {
                    throw localeErr;
                }
            }

            try {
                const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}/?hl=${encodeURIComponent(rawLang)}`;
                await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

                // Handle Cookie Consent (may redirect through consent.google.com)
                const dismissed = await dismissConsentDialog(page);
                if (dismissed) {
                    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
                }

                // Wait for dynamic feed or single-place redirect
                await page.waitForTimeout(3000);

                const currentUrl = page.url();

                // Case 1: Direct redirect to a single place
                if (currentUrl.includes('/maps/place/')) {
                    log.info(`Direct match found for single place: ${currentUrl}`);
                    const details = await extractPlaceDetails(page, currentUrl, includeOpeningHours);
                    details.searchQuery = query;

                    if (details.title) {
                        await Actor.pushData(details);
                        totalPlacesScraped++;
                        if (details.website) placesWithWebsite++;
                        if (details.phone) placesWithPhone++;
                    }
                    continue;
                }

                // Case 2: Feed of multiple listings (actually wait up to 12s for feed to appear)
                const feedLocator = page.locator('div[role="feed"]').first();
                const feedExists = await feedLocator.waitFor({ state: 'visible', timeout: 12000 }).then(() => true).catch(() => false);

                if (!feedExists) {
                    log.warning(`No feed or places found for query "${query}" (current URL: ${page.url()}).`);
                    continue;
                }

                const visitedUrls = new Set();
                let placesExtractedForQuery = 0;
                let scrollRetries = 0;

                while (placesExtractedForQuery < maxCrawledPlacesPerSearch && scrollRetries < 5) {
                    const placeLinks = await page.locator('div[role="feed"] a[href*="/maps/place/"]').all();
                    let newlyFound = 0;

                    for (const link of placeLinks) {
                        if (placesExtractedForQuery >= maxCrawledPlacesPerSearch) break;

                        const href = await link.getAttribute('href').catch(() => null);
                        if (!href || visitedUrls.has(href)) continue;

                        visitedUrls.add(href);
                        newlyFound++;

                        try {
                            await link.scrollIntoViewIfNeeded().catch(() => {});
                            await link.click({ timeout: 4000 }).catch(() => {});
                            await page.waitForTimeout(1800);

                            const details = await extractPlaceDetails(page, href, includeOpeningHours);
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

                    if (placesExtractedForQuery < maxCrawledPlacesPerSearch) {
                        const scrollSuccess = await feedLocator.evaluate((el) => {
                            const prevScroll = el.scrollTop;
                            el.scrollBy(0, 1000);
                            return el.scrollTop > prevScroll;
                        }).catch(() => false);

                        await page.waitForTimeout(2000);

                        const endBanner = page.locator('text="You\'ve reached the end of the list"').first();
                        const isEnd = await endBanner.isVisible().catch(() => false);

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
                if (page && !page.isClosed()) {
                    await page.close().catch(() => {});
                }
            }
        }
    }

    const summary = {
        totalQueries: Array.isArray(searchStringsArray) ? searchStringsArray.length : 0,
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
    throw err;
} finally {
    if (browser) {
        await browser.close().catch(() => {});
    }
    await Actor.exit();
}
