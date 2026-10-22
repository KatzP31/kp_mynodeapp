require('dotenv').config();
const db = require('./db');
const bcrypt = require('bcryptjs');

// Stop immediately if any required setting is missing
const REQUIRED_ENV = ['SESSION_SECRET', 'NASA_API_KEY', 'ADMIN_PASSWORD', 'ADMIN_USERNAME'];
for (const name of REQUIRED_ENV) {
    if (!process.env[name]) {
        console.error(`Missing ${name} in .env (or in Render's Environment settings)`);
        process.exit(1);
    }
}

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

const isProduction = process.env.NODE_ENV === 'production';


// Trim the log file if it's gotten too big
if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 128 * 1024) {
    const recentLines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-10);
    fs.writeFileSync(LOG_FILE, recentLines.join('\n'));
}

// const GUESTBOOK_FILE = path.join(__dirname, 'guestbook.json');

// function getGuestbookMessages() {
//     if (!fs.existsSync(GUESTBOOK_FILE)) return [];
//     return JSON.parse(fs.readFileSync(GUESTBOOK_FILE, 'utf8'));
// }

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
function validateCredentials(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string') {
        return 'Username and password must be text.';
    }
    if (!/^[a-z0-9_]{3,20}$/.test(username.trim().toLowerCase())) {
        return 'Username must be 3 to 20 letters, numbers or underscores.';
    }
    if (password.length < 8 || password.length > 72) {
        return 'Password must be 8 to 72 characters.';
    }
    return null;
}
function startSession(req, user, rememberMe) {
    return new Promise((resolve, reject) => {
        req.session.regenerate((err) => {
            if (err) return reject(err);
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.role = user.role;
            if (rememberMe) {
                req.session.cookie.maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
            }
            resolve();
        });
    });
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
    message: { error: 'Too many requests. Please wait 10 seconds.' }
});
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' }
});
app.use(limiter);

app.use((req, res, next) => {
    if (MAINTENANCE_MODE) return res.status(503).send('Maintenance Mode.');
    next();
});

// Tracks logged-in users via a signed cookie - the browser sends it back
// automatically, no frontend code needed. Requires SESSION_SECRET in .env.
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 15 * 60 * 1000,   // 15 minutes
        httpOnly: true,           // page JavaScript cannot read it
        sameSite: 'lax',          // other sites cannot send it with their forms
        secure: isProduction      // only sent over HTTPS on the live site
    }
}));

function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Please log in first.' });
    }
    next();
}

// For pages: people get sent to the login page
function requireLoginPage(req, res, next) {
    if (!req.session.userId) {
        return res.redirect('/');
    }
    next();
}
// For admin-only pages: everyone else goes back to the home page
function requireAdminPage(req, res, next) {
    if (req.session.role !== 'admin') {
        return res.redirect('/');
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
app.post('/login', authLimiter, async (req, res) => {
    const { username, password, rememberMe } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Username and password are required.' });
    }

    const user = await db.getUserByUsername(username.trim());
    const passwordOk = user && await bcrypt.compare(password, user.passwordHash);

    if (!passwordOk) {
        // Same message whether the username or the password was wrong
        return res.status(401).json({ error: 'Incorrect username or password.' });
    }

    await startSession(req, user, rememberMe);
    res.json({ success: true, username: user.username });
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
// app.get('/dashboard', requireAuth, (req, res) => {
//     res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
// });
// app.get('/dashboard', requireLoginPage, (req, res) => {
app.get('/dashboard', requireAdminPage, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

// Practice routes: only available on your own computer
if (!isProduction) {
    app.get('/api/headers-demo', (req, res) => {
        res.set('X-Student-Name', 'Katz Paniagua');
        res.json({
            browser: req.get('User-Agent'),
            languages: req.get('Accept-Language'),
            allRequestHeaders: req.headers
        });
    });
}
app.get('/api/whoami', (req, res) => {
    if (!req.session.userId) {
        return res.json({ loggedIn: false });
    }
    res.json({
        loggedIn: true,
        userId: req.session.userId,
        username: req.session.username,
        role: req.session.role
    });
});

// Example: run code (logging, a counter, etc.) before serving a page from /public
app.get('/projects', (req, res) => {
    visitorCount++;
    console.log(`Visit #${visitorCount}: someone viewed the projects page`);
    res.sendFile(path.join(PUBLIC_DIR, 'projects.html'));
});


app.get('/guestbook', requireLoginPage, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'guestbook.html'));
});
// READ ALL
app.get('/api/guestbook', requireAuth, async (req, res) => {
    const entries = await db.getAllEntries();
    res.json(entries);
});
// READ ONE
app.get('/api/guestbook/:id', requireAuth, async (req, res) => {
    const entry = await db.getEntryById(req.params.id);
    if (!entry) {
        return res.status(404).json({ error: 'Entry not found.' });
    }
    res.json(entry);
});
// CREATE
app.post('/api/guestbook', requireAuth, async (req, res) => {
    const { name, msg } = req.body;
    const error = validateEntry(name, msg);
    if (error) {
        return res.status(400).json({ error });
    }
    if (filter.isProfane(msg)) {
        return res.status(400).json({ error: 'Please keep your message friendly.' });
    }
    const entry = await db.addEntry({ name: name.trim(), msg: msg.trim() });
    res.status(201).json(entry);
});
// DELETE
app.delete('/api/guestbook/:id', requireAuth, async (req, res) => {
    const deleted = await db.deleteEntry(req.params.id);
    if (!deleted) {
        return res.status(404).json({ error: 'Entry not found.' });
    }
    res.status(204).end();
});// UPDATE
app.put('/api/guestbook/:id', requireAuth, async (req, res) => {
    const { name, msg } = req.body;
    const error = validateEntry(name, msg);
    if (error) {
        return res.status(400).json({ error });
    }

    const updated = await db.updateEntry(req.params.id, {
        name: name.trim(),
        msg: msg.trim()
    });
    if (!updated) {
        return res.status(404).json({ error: 'Entry not found.' });
    }
    res.json(updated);
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
// Lets Render (or anyone) check that the server is running
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});
app.post('/register', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    const error = validateCredentials(username, password);
    if (error) {
        return res.status(400).json({ error });
    }

    const cleanName = username.trim().toLowerCase();
    if (await db.getUserByUsername(cleanName)) {
        return res.status(409).json({ error: 'That username is already taken.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await db.addUser({ username: cleanName, passwordHash });

    await startSession(req, user); // new users are logged in right away
    res.status(201).json({ username: user.username });
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
async function ensureAdmin() {
    const existing = await db.getUserByUsername(process.env.ADMIN_USERNAME);
    if (existing) return;

    const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await db.addUser({ username: process.env.ADMIN_USERNAME, passwordHash, role: 'admin' });
    console.log('Created admin account');
}
// app.listen(PORT, () => console.log(`Server live on http://localhost:${PORT}`));
ensureAdmin().then(() => {
    app.listen(PORT, () => console.log(`Server live on http://localhost:${PORT}`));
});


