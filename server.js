require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const mime = require('mime-types');
const { Filter } = require('bad-words')

const filter = new Filter();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const messages = ["Server booted up successfully"];
let visitorCount = 0;
const ipRequestCounts = new Map();

const adviceList = [
    "Look both ways when crossing a street.",
    "Always wear a seatbelt.",
    "Be kind to others.",
    "Collect 1st Edition Pokemon cards.",
    "Don't forget to water your plants.",
    "Take breaks when working long hours.",
];
const catFacts = [
    "Cats sleep up to 20 hours a day.",
    "A cat's purr can help reduce stress and lower blood pressure.",
    "Cats have a third eyelid called a nictitating membrane.",
    "A group of cats is called a clowder.",
    "Cats can rotate their ears 180 degrees."
];
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.json': 'application/json',
    '.ico': 'image/x-icon'
};
http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const reqPath = parsedUrl.pathname;

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const logLine =
        `[${new Date().toISOString()}] IP: ${clientIp} | Method: ${req.method} | Path: ${reqPath}\n`;

    fs.appendFile(path.join(__dirname, 'server.log'), logLine, (err) => {
        if (err) console.error('Log write failed:', err);
    });

    const now = Date.now();
    const windowMs = 10000; //10-sec window
    const maxRequests = 10;

    for (const [ip, data] of ipRequestCounts) {
        if (now > data.resetTime) {
            ipRequestCounts.delete(ip);
        }
    }

    const ipData = ipRequestCounts.get(clientIp) || { count: 0, resetTime: now + windowMs };

    if (now > ipData.resetTime) {
        ipData.count = 0;
        ipData.resetTime = now + windowMs;
    }

    ipData.count++;
    ipRequestCounts.set(clientIp, ipData);

    if (ipData.count > maxRequests) {
        res.writeHead(429, { 'Content-Type': 'text/html', "retry-after": '10' });
        return res.end('<h1>429 Too Many Requests<h1><p>Please wait 10 seconds.</p>')
    }

    const DATA_FILE = path.join(__dirname, 'messages.json');

    const action = parsedUrl.searchParams.get('action');

    if (action === 'clear') {
        const defaultMsg = ["All messages cleared by Admin."];
        fs.writeFileSync(DATA_FILE, JSON.stringify(defaultMsg, null, 2));
        res.writeHead(302, { 'Location': '/admin' });
        return res.end();
    }

    function getSavedMessages() {
        if (!fs.existsSync(DATA_FILE)) return ["Server booted up."];
        return JSON.parse(fs.readFileSync(DATA_FILE));
    }

    const newMsg = parsedUrl.searchParams.get('msg');

    if (newMsg) {
        const messages = getSavedMessages();

        const cleanedInput = newMsg.replace(/\s+/g, '').trim();
        const compactInput = cleanedInput.replace(/\s+/g, '');

        const filteredMsg = filter.isProfane(compactInput)
            ? '[Message removed]'
            : filter.clean(cleanedInput);

        messages.push(filteredMsg);
        const recentMessages = messages.slice(-100);
        fs.writeFileSync(DATA_FILE, JSON.stringify(recentMessages, null, 2));
        res.writeHead(302, { Location: '/shoutbox' });
        return res.end();
    }

    if (reqPath === '/shoutbox') {
        const password = parsedUrl.searchParams.get('password');
        const shoutboxPassword = process.env.SHOUTBOX_PASSWORD;
        console.log(password);
        if (password !== shoutboxPassword) {
            console.log('Not the correct password');
            res.writeHead(401, { 'Content-Type': 'text/html' });
            return res.end(`
                <h1>401 Unauthorized</h1>
                <p>Incorrect or missing password</p>
                <a href="/">Go back and try again</a>
                `);
        }

    }
    if (reqPath === '/admin') {
        const password = parsedUrl.searchParams.get('password');
        const adminPassword = process.env.ADMIN_PASSWORD;
        console.log(password);
        if (password !== adminPassword) {
            console.log('Not the correct password');
            res.writeHead(401, { 'Content-Type': 'text/html' });
            return res.end(`
                <h1>401 Unauthorized</h1>
                <p>Incorrect or missing password</p>
                <a href="/">Go back and try again</a>
                `);
        }

    }

    if (reqPath === '/roll') {
        console.log("/roll route accessed");
        let roll = Math.floor(Math.random() * 6) + 1;
        console.log(`Roll: ${roll}`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<h1>Roll: ${roll}</h1>`);
    }
    if (reqPath === '/api/stats') {
        const stats = {
            visitorCount: visitorCount,
            uptimeSeconds: process.uptime(),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(stats));
    }

    if (reqPath === '/api/system') {
        const systemInfo = {
            platform: os.platform(),
            cpus: os.cpus().length,
            freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
            totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
            uptimeMinutes: Math.round(process.uptime() / 60)
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(systemInfo, null, 2));
    }


    let normalizedPath = reqPath === '/' ? '/index.html' : reqPath;
    if (!path.extname(normalizedPath)) {
        normalizedPath += '.html';
    }
    const filePath = path.join(PUBLIC_DIR, normalizedPath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mime.lookup(filePath) || 'text/plain';
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            return res.end('<h1>404: Page Not Found</h1>');
        }
        let finalContent = content;
        if (ext === '.html') {
            let randomAdvice = adviceList[Math.floor(Math.random() * adviceList.length)];
            console.log(randomAdvice);
            let randomCatFact = catFacts[Math.floor(Math.random() * catFacts.length)];
            console.log(randomCatFact);
            if (normalizedPath === '/index.html') {
                visitorCount++;
                console.log(`[VISIT #${visitorCount}] Connection from: ${req.socket.remoteAddress}`);
            }
            const theme = parsedUrl.searchParams.get('theme') === 'dark' ? 'dark-mode' : 'light-mode';
            const messageListHTML = getSavedMessages().map(msg => `<li>${msg}</li>`).join('');
            finalContent = content.toString()
                .replace('{{COUNT}}', String(visitorCount))
                .replace('{{THEME_CLASS}}', theme)
                .replace('{{FACT}}', randomAdvice)
                .replace('{{CAT_FACT}}', randomCatFact)
                .replace('{{MESSAGES}}', messageListHTML);
        }
        console.log(`[REQUEST] ${req.socket.remoteAddress} accessed ${normalizedPath}`);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(finalContent);
    });
}).listen(PORT, () => console.log(`Server listening on port ${PORT}`));
