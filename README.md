# 📍 Google Maps B2B Leads Scraper (Places, Phone, Website & Reviews)

Extract targeted B2B leads, local business contacts, phone numbers, websites, addresses, star ratings, and GPS coordinates from Google Maps at scale.

---

## 🌟 Key Features

- 🏢 **Complete B2B Contact Profiles**: Extracts business name, category, complete street address, phone number, website URL, and opening hours.
- ⭐ **Reputation Metrics**: Captures average rating score (0.0 to 5.0) and total user reviews count.
- 🗺️ **Accurate GPS Geolocation**: Extracts exact latitude and longitude coordinates from map pins.
- 🔄 **Smart Infinite Scroll**: Automatically navigates Google Maps feed listings with automated consent dialog bypass.
- 🌐 **Global Multilingual Support**: Supports any language (`language` code) and any localized query around the world.
- 🛡️ **Apify Proxy Integration**: Ready to connect with Apify Residential and Datacenter proxies for uninterrupted scraping.

---

## 📥 Input Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `searchStringsArray` | Array | `["restaurants in New York"]` | List of keywords or locations to search (e.g. `'dentists in New York'`, `'plumbers in Berlin'`). |
| `maxCrawledPlacesPerSearch` | Integer | `40` | Maximum number of places to scrape per search query. |
| `language` | String | `"en"` | Language code for names and descriptions (e.g. `en`, `es`, `fr`, `de`, `ar`). |
| `includeOpeningHours` | Boolean | `true` | Extract full weekly operating schedule. |
| `proxyConfiguration` | Object | `{ "useApifyProxy": true }` | Apify Proxy configuration settings. |

---

## 📤 Output Data Format

Each dataset record contains rich business intelligence:

```json
{
  "title": "Monmouth Coffee Company",
  "category": "Coffee shop",
  "address": "27 Monmouth St, London WC2H 9EU, United Kingdom",
  "phone": "+44 20 7232 3010",
  "website": "https://www.monmouthcoffee.co.uk/",
  "totalScore": 4.6,
  "reviewsCount": 1845,
  "openStatus": "Open ⋅ Closes 6 PM",
  "openingHours": [
    "Monday: 7:30 AM – 6:00 PM",
    "Tuesday: 7:30 AM – 6:00 PM",
    "Wednesday: 7:30 AM – 6:00 PM",
    "Thursday: 7:30 AM – 6:00 PM",
    "Friday: 7:30 AM – 6:00 PM",
    "Saturday: 8:00 AM – 6:00 PM",
    "Sunday: Closed"
  ],
  "latitude": 51.513518,
  "longitude": -0.126584,
  "placeId": "0x487604cc863bc0d9:0x8992ad34e12e138a",
  "url": "https://www.google.com/maps/place/Monmouth+Coffee+Company/...",
  "searchQuery": "restaurants in New York",
  "scrapedAt": "2026-11-09T13:40:00.000Z"
}
```

---

## 💡 Practical Use Cases

1. **B2B Cold Outreach & Sales**: Collect qualified business leads (phone numbers, addresses, websites) for digital agencies, SaaS companies, and contractors.
2. **Local Directory & Marketplace Aggregation**: Populate local directories with verified business listings and opening hours.
3. **Competitive Benchmarking**: Analyze market density, pricing levels, and rating distribution in specific neighborhoods or cities.
4. **GIS & Location Analytics**: Map business distributions across geographical regions using accurate GPS coordinates.

---

## ⚖️ License
Apache-2.0
