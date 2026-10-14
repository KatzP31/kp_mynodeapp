require('dotenv').config();

const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { Filter } = require('bad-words');

const fs = require('fs');
const path = require('path');

const crypto = require('crypto');
const helmet = require('helmet');

const filter = new Filter();
const app = express();

const apodCache = new Map();
const TODAY_MAX_AGE = 60 * 60 * 1000; // 1 hour in milliseconds
const MAX_CACHE_SIZE = 100;



// Trust the X-Forwarded-For header set by hosts like Render, so the rate
// limiter sees each visitor's real IP instead of the proxy's
app.set('trust proxy', 1);
// app.use(helmet({ contentSecurityPolicy: false }));
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            imgSrc: ["'self'", 'data:', 'https://assets.science.nasa.gov']
        }
    }
}));
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_FILE = path.join(__dirname, 'server.log');

let visitorCount = 0;

let MAINTENANCE_MODE = false;

// Trim the log file if it's gotten too big
if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 128 * 1024) {
    const recentLines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-10);
    fs.writeFileSync(LOG_FILE, recentLines.join('\n'));
}

const GUESTBOOK_FILE = path.join(__dirname, 'guestbook.json');

function getGuestbookMessages() {
    if (!fs.existsSync(GUESTBOOK_FILE)) return [];
    return JSON.parse(fs.readFileSync(GUESTBOOK_FILE, 'utf8'));
}

function validateEntry(name, msg) {
    if (typeof name !== 'string' || typeof msg !== 'string') {
        return 'Name and message must be text.';
    }
    if (name.trim().length < 1 || name.trim().length > 40) {
        return 'Name must be 1 to 40 characters.';
    }
    if (msg.trim().length < 1 || msg.trim().length > 280) {
        return 'Message must be 1 to 280 characters.';
    }
    return null;
}
// ==========================================
// MIDDLEWARE SETUP
// Each function below runs on every request, then calls next() to pass
// it along - like a checkpoint before your routes.
// ==========================================

// Parse incoming POST form data (from <form> submissions) and JSON bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Logs every request to the console and to server.log
app.use((req, res, next) => {
    const logLine = `[${new Date().toISOString()}] ${req.method} ${req.path}\n`;
    console.log(logLine.trim());
    fs.appendFile(LOG_FILE, logLine, (err) => {
        if (err) console.error('Log write failed:', err);
    });
    next();
});

// Rate limiter - blocks an IP with a 429 response if it sends too many
// requests within the time window
const limiter = rateLimit({
    windowMs: 10 * 1000, // 10 second window
    limit: 100,          // max requests per window, per IP
    message: '<h1>429 Too Many Requests</h1><p>Please wait 10 seconds.</p>'
});
app.use(limiter);

app.use((req, res, next) => {
    if (MAINTENANCE_MODE) return res.status(503).send('Maintenance Mode.');
    next();
});

// Tracks logged-in users via a signed cookie - the browser sends it back
// automatically, no frontend code needed. Requires SESSION_SECRET in .env.
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 15 * 60 * 1000 } // session expires after 15 minutes
}));

// Route guard - use this on any route that should require login.
// Example: app.get('/dashboard', requireAuth, (req, res) => { ... });
function requireAuth(req, res, next) {
    if (!req.session.isAuthenticated) {
        return res.status(401).json({ error: 'Please log in first.' });
    }
    next();
}

// ==========================================
// ROUTES
// Fill these in! Example routes are shown below.
// ==========================================

app.get('/api/hello', (req, res) => {
    res.json({ message: 'Hello, world!' });
});

// Exposes the visitor count as JSON, e.g. for a frontend script to display
app.get('/api/stats', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ visitorCount });
});

// Checks the password against .env; marks the session authenticated if correct
app.post('/login', (req, res) => {
    const { password, rememberMe } = req.body;
    if (password === process.env.APP_PASSWORD) {
        req.session.isAuthenticated = true;
        if (rememberMe) {
            req.session.cookie.maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
        }
        return res.json({ success: true });
    }
    res.status(401).json({ success: false, error: 'Incorrect password' });
});

// Logout - destroys the session so req.session.isAuthenticated is gone
app.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({
            success: true
        });
    });
});

// Example protected route - try visiting this without logging in first
app.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

app.get('/api/headers-demo', (req, res) => {
    res.set('X-Student-Name', 'Katz Paniagua');
    res.json({
        browser: req.get('User-Agent'),
        languages: req.get('Accept-Language'),
        allRequestHeaders: req.headers
    });
});
app.get('/api/whoami', (req, res) => {
    res.json({ loggedIn: !!req.session.isAuthenticated });
});

// Example: run code (logging, a counter, etc.) before serving a page from /public
app.get('/projects', (req, res) => {
    visitorCount++;
    console.log(`Visit #${visitorCount}: someone viewed the projects page`);
    res.sendFile(path.join(PUBLIC_DIR, 'projects.html'));
});

app.get('/guestbook', requireAuth, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'guestbook.html'));
});

app.get('/api/guestbook', requireAuth, (req, res) => {
    res.json(getGuestbookMessages());
});

// // app.post('/api/guestbook', requireAuth, (req, res) => {
// //     const { msg } = req.body;
// //     if (!msg) {
// //         return res.status(400).json({ error: 'Message is required' });
// //     }
// //     const messages = getGuestbookMessages();

// //     const cleanedInput = msg.replace(/\s+/g, '').trim();
// //     const compactInput = cleanedInput.replace(/\s+/g, '');
// //     if (filter.isProfane(compactInput)) {
// //         return res.status(400).json({ error: 'Message contains profanity' });
// //     }
// //     messages.push(cleanedInput);

// //     fs.writeFileSync(GUESTBOOK_FILE, JSON.stringify(messages.slice(-10), null, 2));
// //     res.json({ success: true });
// // });
app.post('/api/guestbook', requireAuth, (req, res) => {
    const { name, msg } = req.body;

    const error = validateEntry(name, msg);
    if (error) {
        return res.status(400).json({ error: error });
    }

    const messages = getGuestbookMessages();
    // const cleanedInput = msg.replace(/\s+/g, '').trim();
    // const compactInput = cleanedInput.replace(/\s+/g, '');
    const cleanedInput = msg.trim();
    const compactInput = cleanedInput.replace(/\s+/g, '');
    if (filter.isProfane(compactInput)) {
        return res.status(400).json({ error: 'Message contains profanity' });
    }

    const entry = {
        id: crypto.randomUUID(),
        name: name.trim(),
        msg: cleanedInput,
        createdAt: new Date().toISOString()
    };

    messages.push(entry);
    fs.writeFileSync(GUESTBOOK_FILE, JSON.stringify(messages.slice(-50), null, 2));
    res.status(201).json(entry);
});


app.get('/', (req, res) => {
    visitorCount++;
    console.log(`Visit #${visitorCount}: someone viewed the landing page`);
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// app.post('/your-route-here', (req, res) => {
//
// });

// Returns an error message, or null if the date is OK
function validateApodDate(date) {
    if (date === undefined) return null; // no date means today

    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return 'Date must look like YYYY-MM-DD.';
    }

    // new Date() quietly rolls Feb 30 over to Mar 2, so convert it
    // back to text and check that it did not change
    const parsed = new Date(date + 'T00:00:00Z');
    if (isNaN(parsed) || parsed.toISOString().slice(0, 10) !== date) {
        return 'That is not a real date.';
    }

    if (date < '1995-06-16') {
        return 'The first picture is from 1995-06-16.';
    }

    const today = new Date().toISOString().slice(0, 10);
    if (date > today) {
        return 'That date is in the future.';
    }

    return null;
}
app.get('/api/space', async (req, res) => {
    const { date } = req.query;
    //date validation
    const cacheKey = date || 'today';
    const cached = apodCache.get(cacheKey);
    const isFresh = cacheKey !== 'today' || Date.now() - cached?.savedAt < TODAY_MAX_AGE;

    if (cached && isFresh) {
        console.log('Cache hit:', cacheKey);
        return res.json(cached.data);
    }

    const dateError = validateApodDate(date);
    if (dateError) {
        return res.status(400).json({ error: dateError });
    }
    if (!process.env.NASA_API_KEY) {
        throw new Error('NASA_API_KEY is missing from .env');
    }

    // NASA has one address for the latest pictures, and another for one day.
    // The one-day address uses the date as YYMMDD: 2025-07-04 becomes 250704
    let address = 'https://science.nasa.gov/wp-json/wp/v2/apod-basic/';
    if (date) {
        const shortDate = date.slice(2).replaceAll('-', '');
        address = address + shortDate;
    }

    // Add the secret key on the server
    const nasaUrl = new URL(address);
    nasaUrl.searchParams.set('api_key', process.env.NASA_API_KEY);

    let nasaResponse;
    try {
        // Give up if NASA takes longer than 8 seconds
        nasaResponse = await fetch(nasaUrl, { signal: AbortSignal.timeout(8000) });
    } catch (err) {
        return res.status(502).json({ error: 'Could not reach NASA. Try again later.' });
    }

    if (nasaResponse.status === 404) {
        return res.status(404).json({ error: 'NASA has no picture for that date.' });
    }
    if (!nasaResponse.ok) {
        console.error('NASA error:', nasaResponse.status);
        return res.status(502).json({ error: 'NASA could not send a picture right now.' });
    }

    const data = await nasaResponse.json();

    // With a date, NASA sends one picture. Without one, it sends a list,
    // and the first item is the newest.
    const picture = Array.isArray(data) ? data[0] : data;

    // Send back only what our page needs, with names we chose
    const result = {
        title: picture.title,
        date: picture.date,
        imageUrl: picture.hdurl,
        description: picture.alt,
        nasaPage: picture.permalink
    };

    apodCache.set(cacheKey, { data: result, savedAt: Date.now() });

    // Too many entries? Remove the oldest one (a Map remembers insertion order)
    if (apodCache.size > MAX_CACHE_SIZE) {
        const oldestKey = apodCache.keys().next().value;
        apodCache.delete(oldestKey);
    }

    res.json(result);
});


// ==========================================
// STATIC FILES
// Serves everything in /public (put this AFTER your routes)
// `extensions: ['html']` lets /projects find projects.html without the extension
// ==========================================
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});
app.use((err, req, res, next) => {
    // Full details go to YOU, in the console and the log file
    const time = new Date().toISOString();
    console.error(`[${time}] ERROR ${req.method} ${req.path}`, err);
    fs.appendFile(LOG_FILE, `[${time}] ERROR ${req.method} ${req.path}: ${err.message}\n`, () => { });

    // If a response already started sending, let Express finish up
    if (res.headersSent) return next(err);

    // Errors with a status under 500 are the user's fault and safe to explain.
    // Anything else is our fault, so hide the details.
    const status = err.status || 500;
    const message = status < 500 ? err.message : 'Something went wrong on our end.';

    if (req.path.startsWith('/api/')) {
        return res.status(status).json({ error: message });
    }
    res.status(status).send('<h1>Something went wrong</h1><p>Please try again later.</p><a href="/">Back to home</a>');
});
app.listen(PORT, () => console.log(`Server live on http://localhost:${PORT}`));



