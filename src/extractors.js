/**
 * Google Maps Data Extraction Utilities
 */

/**
 * Parse coordinates from Google Maps URL (e.g., .../@40.7127753,-74.0059728,15z/... or !3d40.712!4d-74.005)
 */
export function parseCoordinatesFromUrl(url) {
    if (!url) return { latitude: null, longitude: null };
    const atMatch = url.match(/@([0-9.-]+),([0-9.-]+)/);
    if (atMatch) {
        return {
            latitude: parseFloat(atMatch[1]),
            longitude: parseFloat(atMatch[2]),
        };
    }
    const bangMatch = url.match(/!3d([0-9.-]+)!4d([0-9.-]+)/);
    if (bangMatch) {
        return {
            latitude: parseFloat(bangMatch[1]),
            longitude: parseFloat(bangMatch[2]),
        };
    }
    return { latitude: null, longitude: null };
}

/**
 * Clean and normalize phone number string
 */
export function cleanPhone(raw) {
    if (!raw) return null;
    const cleaned = raw.replace(/[^\d+()\-\s]/g, '').trim();
    return cleaned.length >= 6 ? cleaned : null;
}

/**
 * Parse star rating (e.g., "4.5" or "4,5" or "4.5 stars")
 */
export function parseRating(raw) {
    if (!raw) return null;
    const match = raw.replace(',', '.').match(/([0-5]\.[0-9]|[0-5])/);
    return match ? parseFloat(match[1]) : null;
}

/**
 * Parse reviews count (e.g. "(1,234)" or "1.234 reviews")
 */
export function parseReviewsCount(raw) {
    if (!raw) return 0;
    const digits = raw.replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : 0;
}

/**
 * Dismiss Google cookie / privacy consent modals if present
 */
export async function dismissConsentDialog(page) {
    const consentSelectors = [
        'button:has-text("Accept all")',
        'input[type="submit"][value*="Accept" i]',
        'button:has-text("I agree")',
        'button:has-text("Agree")',
        'button:has-text("Tout accepter")',
        'button:has-text("Alle akzeptieren")',
        'button:has-text("Aceptar todo")',
        'button:has-text("Accetta tutto")',
        'form:has(button) button[aria-label*="Accept" i]',
        'button[jsname="b3IdNt"]',
        'button[aria-label*="Agree" i]',
    ];

    for (const selector of consentSelectors) {
        try {
            const btn = page.locator(selector).first();
            if (await btn.isVisible().catch(() => false)) {
                await btn.click();
                await page.waitForTimeout(2000);
                return true;
            }
        } catch {
            // Ignore not found
        }
    }
    return false;
}

/**
 * Extract listing details from the active place detail panel in Playwright
 */
export async function extractPlaceDetails(page, fallbackUrl = '', includeOpeningHours = true) {
    // Wait briefly for place title heading to appear in details pane
    await page.locator('h1.DUwDvf, h1.fontHeadlineLarge').first()
        .waitFor({ state: 'visible', timeout: 3500 })
        .catch(() => {});

    const currentUrl = page.url() || fallbackUrl;
    let coords = parseCoordinatesFromUrl(fallbackUrl);
    if (coords.latitude === null) {
        coords = parseCoordinatesFromUrl(currentUrl);
    }
    const { latitude, longitude } = coords;

    // Extract Title
    let title = null;
    const titleSelectors = [
        'h1.DUwDvf',
        'h1.fontHeadlineLarge',
        'h1',
        'div.qBF1Pd',
    ];
    for (const sel of titleSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible().catch(() => false)) {
            title = (await el.innerText()).trim();
            if (title) break;
        }
    }

    // Extract Rating & Reviews
    let totalScore = null;
    let reviewsCount = 0;
    try {
        const ratingEl = page.locator('div.F7nice span[aria-hidden="true"]').first();
        if (await ratingEl.isVisible().catch(() => false)) {
            totalScore = parseRating(await ratingEl.innerText());
        }

        const reviewsEl = page.locator('div.F7nice span[aria-label*="review" i], div.F7nice span:nth-child(2) span').first();
        if (await reviewsEl.isVisible().catch(() => false)) {
            reviewsCount = parseReviewsCount(await reviewsEl.innerText());
        }
    } catch {
        // Fallback
    }

    // Extract Category
    let category = null;
    try {
        const catEl = page.locator('button[jsaction*="category"], div.fontBodyMedium button').first();
        if (await catEl.isVisible().catch(() => false)) {
            category = (await catEl.innerText()).trim();
        }
    } catch {
        // Fallback
    }

    // Extract Address
    let address = null;
    try {
        const addrEl = page.locator('button[data-item-id="address"]').first();
        if (await addrEl.isVisible().catch(() => false)) {
            const fullText = await addrEl.innerText();
            address = fullText.replace(/^Address:\s*/i, '').trim();
        }
    } catch {
        // Fallback
    }

    // Extract Website
    let website = null;
    try {
        const webEl = page.locator('a[data-item-id="authority"]').first();
        if (await webEl.isVisible().catch(() => false)) {
            website = await webEl.getAttribute('href');
        }
    } catch {
        // Fallback
    }

    // Extract Phone
    let phone = null;
    try {
        const phoneEl = page.locator('button[data-item-id*="phone"]').first();
        if (await phoneEl.isVisible().catch(() => false)) {
            const phoneText = await phoneEl.innerText();
            phone = cleanPhone(phoneText);
        }
    } catch {
        // Fallback
    }

    // Extract Open Status & Hours
    let openStatus = null;
    let openingHours = [];
    if (includeOpeningHours) {
        try {
            const hoursSummary = page.locator('div[data-item-id*="hours"] span.fontBodyMedium').first();
            if (await hoursSummary.isVisible().catch(() => false)) {
                openStatus = (await hoursSummary.innerText()).trim();
            }

            const hoursTableRows = await page.locator('table.eKjhZj tr').all();
            for (const row of hoursTableRows) {
                const rowText = (await row.innerText()).replace(/\n/g, ' ').trim();
                if (rowText) openingHours.push(rowText);
            }
        } catch {
            // Fallback
        }
    }

    // Extract Place ID or CID
    let placeId = null;
    const cidMatch = (fallbackUrl || currentUrl).match(/0x[0-9a-fA-F]+:0x[0-9a-fA-F]+/);
    if (cidMatch) {
        placeId = cidMatch[0];
    }

    return {
        title,
        category,
        address,
        phone,
        website,
        totalScore,
        reviewsCount,
        openStatus,
        openingHours: openingHours.length > 0 ? openingHours : null,
        latitude,
        longitude,
        placeId,
        url: fallbackUrl || currentUrl,
        scrapedAt: new Date().toISOString(),
    };
}
