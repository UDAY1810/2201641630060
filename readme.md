# URL Shortener Backend with Logging Middleware

This is a single-file Express + MongoDB backend that provides:
- URL Shortening service (with custom shortcodes and expiry support)
- Redirect functionality
- Stats tracking (clicks, IP, referrer, location, user-agent)
- Integrated Logging Middleware that sends logs to the Affordmed Evaluation Server

---

## 🚀 Features
- **POST /shorturls** → Create short URL (custom shortcode optional, default validity = 30 minutes)
- **GET /:code** → Redirect to original URL (with click tracking)
- **GET /shorturls/:code** → Get stats for a short URL
- **GET /health** → Health check
- **Logging Middleware** → Logs all requests + important events to evaluation server
- **Expiration Handling** → Short URLs expire after given time

---

## 📂 Project Structure
