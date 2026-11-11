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

async function launchMapsSession(proxyUrl, rawLang, safeLocale) {
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

    const browser = await chromium.launch(launchOptions);
    const baseContextOptions = {
        viewport: { width: 1280, height: 900 },
        extraHTTPHeaders: {
            'Accept-Language': `${rawLang},${safeLocale},en;q=0.9`,
        },
    };

    let context = await browser.newContext({
        ...baseContextOptions,
        locale: safeLocale,
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    let page;
    try {
        page = await context.newPage();
    } catch (localeErr) {
        if (localeErr.message && localeErr.message.includes('Invalid locale name')) {
            log.warning(`Browser rejected locale "${safeLocale}", recreating context with default locale...`);
            await context.close().catch(() => {});
            context = await browser.newContext(baseContextOptions);
            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });
            page = await context.newPage();
        } else {
            await browser.close().catch(() => {});
            throw localeErr;
        }
    }

    // Abort heavy non-essential media/font/map-tile assets for faster loading over proxies
    await page.route('**/*', (route) => {
        const req = route.request();
        const type = req.resourceType();
        const url = req.url();
        if (type === 'media' || type === 'font' || url.includes('/maps/vt?') || url.includes('khms')) {
            return route.abort();
        }
        return route.continue();
    });

    return { browser, context, page };
}

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

    let totalPlacesScraped = 0;
    let placesWithWebsite = 0;
    let placesWithPhone = 0;

    if (!Array.isArray(searchStringsArray) || searchStringsArray.length === 0) {
        log.warning('No search queries provided in searchStringsArray. Nothing to scrape.');
    } else {
        log.info(`Starting Google Maps Leads Scraper for ${searchStringsArray.length} queries (limit: ${maxCrawledPlacesPerSearch} places/query)`);

        const proxyConfig = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : null;
        if (proxyConfig) {
            log.info('Configured Apify Proxy successfully');
        }

        const rawLang = (typeof language === 'string' && language.trim()) ? language.trim() : 'en';
        const safeLocale = normalizeLocale(rawLang);

        for (const query of searchStringsArray) {
            log.info(`Searching Google Maps for: "${query}"`);
            const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}/?hl=${encodeURIComponent(rawLang)}`;

            let session = null;
            let navigated = false;

            // Up to 3 navigation attempts: proxy IP 1 -> rotated proxy IP 2 -> direct connection fallback
            const attempts = proxyConfig ? ['proxy', 'proxy', 'direct'] : ['direct'];

            for (let i = 0; i < attempts.length; i++) {
                const mode = attempts[i];
                const attemptProxyUrl = mode === 'proxy' ? await proxyConfig.newUrl() : undefined;

                if (session) {
                    await session.browser.close().catch(() => {});
                    session = null;
                }

                try {
                    session = await launchMapsSession(attemptProxyUrl, rawLang, safeLocale);
                    log.info(`Attempt ${i + 1}/${attempts.length} (${mode}): loading Google Maps...`);

                    const response = await session.page.goto(searchUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000,
                    });

                    const status = response ? response.status() : 'unknown';
                    const landedUrl = session.page.url();

                    if (status === 429 || landedUrl.includes('/sorry/')) {
                        log.warning(`Blocked by Google (status ${status}) on attempt ${i + 1}. Rotating...`);
                        continue;
                    }

                    log.info(`Loaded Maps page cleanly (HTTP ${status}) -> ${landedUrl}`);
                    navigated = true;
                    break;
                } catch (navErr) {
                    log.warning(`Navigation failed on attempt ${i + 1} (${mode}): ${navErr.message}`);
                }
            }

            if (!navigated || !session) {
                log.error(`All navigation attempts failed for query "${query}".`);
                if (session) await session.browser.close().catch(() => {});
                continue;
            }

            const { page, browser } = session;

            try {
                // Handle Google cookie / consent dialog if present
                const dismissed = await dismissConsentDialog(page);
                if (dismissed) {
                    log.info('Dismissed Google consent dialog');
                    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
                }

                // Wait for either the results feed OR single-place heading
                await page.locator('div[role="feed"], h1.DUwDvf, h1.fontHeadlineLarge').first()
                    .waitFor({ state: 'visible', timeout: 15000 })
                    .catch(() => {});

                const currentUrl = page.url();
                const feedLocator = page.locator('div[role="feed"]').first();
                const feedExists = await feedLocator.isVisible().catch(() => false);

                // Case 1: Direct redirect to a single place (no feed list)
                if (!feedExists || currentUrl.includes('/maps/place/')) {
                    if (feedExists) {
                        // Prefer iterating feed when feed exists
                    } else {
                        log.info(`Single place or direct entity match detected: ${currentUrl}`);
                        const details = await extractPlaceDetails(page, currentUrl, includeOpeningHours);
                        details.searchQuery = query;

                        if (details.title) {
                            await Actor.pushData(details);
                            totalPlacesScraped++;
                            if (details.website) placesWithWebsite++;
                            if (details.phone) placesWithPhone++;
                            log.info(`[1/1] Extracted single place: "${details.title}" | Tel: ${details.phone || 'N/A'} | Web: ${details.website || 'N/A'}`);
                        } else {
                            log.warning(`No feed or place title found for query "${query}" (URL: ${currentUrl}).`);
                        }
                        continue;
                    }
                }

                // Case 2: Feed of multiple business listings
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
                await browser.close().catch(() => {});
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
    await Actor.exit();
}
