const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { google } = require('googleapis');
const WebSocket = require('ws');

// อ่านไฟล์ credentials จาก JSON
const credentials = JSON.parse(fs.readFileSync(path.join(__dirname, '/asset/justice-for-goat-0aea88bb0952.json')));
const SHEET_ID = '1x9qnwqE-IgzcFaCIEmmv0d4eYIdZY_0JAIQnxuanKpI';
const ANNOUNCEMENT_RANGE = 'Sheet1!G2';
const RANKS_RANGE = 'Sheet1!A:C';

// ฟังก์ชัน Google Sheets
const getSheetsClient = async () => {
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const client = await auth.getClient();
    return google.sheets({ version: 'v4', auth: client });
};

// ฟังก์ชันเพิ่มข้อมูล (สำหรับส่งดอกไม้)
// ฟังก์ชันเพิ่มข้อมูล (สำหรับส่งดอกไม้)
async function addDataToSheet(name, country, flowers) {
    const sheets = await getSheetsClient();
    try {
        const { data } = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: RANKS_RANGE,
        });

        const rows = data.values || [];
        let updated = false;

        for (let i = 0; i < rows.length; i++) {
            if (rows[i][0] === name && rows[i][1] === country) {
                const newCount = (parseInt(rows[i][2]) || 0) + flowers;
                rows[i][2] = newCount;

                await sheets.spreadsheets.values.update({
                    spreadsheetId: SHEET_ID,
                    range: `Sheet1!A${i + 1}:C${i + 1}`,
                    valueInputOption: 'RAW',
                    resource: { values: [[name, country, newCount]] },
                });

                updated = true;
                break;
            }
        }

        if (!updated) {
            await sheets.spreadsheets.values.append({
                spreadsheetId: SHEET_ID,
                range: 'Sheet1!A2',
                valueInputOption: 'RAW',
                resource: { values: [[name, country, flowers]] },
            });
        }

        // เรียกใช้งานฟังก์ชัน Broadcast เพื่อส่งข้อมูล Rank ผ่าน WebSocket
        await broadcastRankUpdates();

    } catch (err) {
        console.error('Error updating Google Sheets:', err);
        throw err;
    }
}


// ฟังก์ชันดึงอันดับ
async function getRanks(latestName) {
    const sheets = await getSheetsClient();
    try {
        const { data } = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: RANKS_RANGE,
        });

        const rows = data.values || [];
        const dataList = rows.map((row) => ({
            name: row[0],
            country: row[1],
            flowers: parseInt(row[2]) || 0,
        }));

        dataList.sort((a, b) => b.flowers - a.flowers);

        const topSenders = dataList.slice(0, 30);
        const countrySummary = {};

        dataList.forEach(({ country, flowers }) => {
            countrySummary[country] = (countrySummary[country] || 0) + flowers;
        });

        const topCountries = Object.entries(countrySummary)
            .map(([country, flowers]) => ({ country, flowers }))
            .sort((a, b) => b.flowers - a.flowers)
            .slice(0, 10);

        const latestRank = latestName
            ? dataList.findIndex((entry) => entry.name === latestName) + 1
            : -1;

        return { topSenders, topCountries, latestRank };
    } catch (err) {
        console.error('Error fetching ranks:', err);
        throw err;
    }
}

// ฟังก์ชันบันทึกข้อความประกาศ
async function postAnnouncement(message) {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: ANNOUNCEMENT_RANGE,
        valueInputOption: 'RAW',
        resource: { values: [[message]] },
    });
}

// ฟังก์ชันดึงข้อความประกาศ
async function getAnnouncements() {
    const sheets = await getSheetsClient();
    const { data } = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: ANNOUNCEMENT_RANGE,
    });
    return data.values ? data.values[0][0] : 'Welcome to the announcement board! 🎉';
}

// สร้างเซิร์ฟเวอร์ HTTP
const PORT = 3000;
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const { pathname } = parsedUrl;

    if (req.method === 'POST' && pathname === '/submit') {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', async () => {
            try {
                const { name, country, flowers } = JSON.parse(body);
                await addDataToSheet(name, country, parseInt(flowers));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Data added successfully!' }));
            } catch (err) {
                console.error('Error adding data:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to add data' }));
            }
        });
    } else if (req.method === 'GET' && pathname === '/api/ranks') {
        try {
            const latestName = parsedUrl.query.name || null;
            const ranks = await getRanks(latestName);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(ranks));
        } catch (err) {
            console.error('Error fetching ranks:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to fetch ranks' }));
        }
    } else if (req.method === 'POST' && pathname === '/post-announcement') {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', async () => {
            try {
                const { message } = JSON.parse(body);
                await postAnnouncement(message);
                broadcastAnnouncement(message); // ส่งข้อความใหม่ผ่าน WebSocket
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (err) {
                console.error('Error posting announcement:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to post announcement' }));
            }
        });
    } else if (req.method === 'GET' && pathname === '/get-announcements') {
        try {
            const announcement = await getAnnouncements();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ announcement }));
        } catch (err) {
            console.error('Error fetching announcement:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to fetch announcements' }));
        }
    } else {
        let filePath = '.' + parsedUrl.pathname;
        if (filePath === './') filePath = './index.html';

        const extname = path.extname(filePath);
        let contentType = 'text/html';

        switch (extname) {
            case '.js':
                contentType = 'text/javascript';
                break;
            case '.css':
                contentType = 'text/css';
                break;
            case '.json':
                contentType = 'application/json';
                break;
            case '.png':
                contentType = 'image/png';
                break;
            case '.jpg':
            case '.jpeg':
                contentType = 'image/jpeg';
                break;
        }

        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('404 Not Found');
            } else {
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content, 'utf8');
            }
        });
    }
});

// เพิ่ม WebSocket Server
const wss = new WebSocket.Server({ server });
// ฟังก์ชันส่งข้อมูลอันดับ (Ranks) ผ่าน WebSocket
const broadcastRankUpdates = async () => {
    try {
        const ranks = await getRanks(); // เรียกข้อมูลอันดับล่าสุด
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'rankUpdate', ranks }));
            }
        });
    } catch (err) {
        console.error('Error broadcasting rank updates:', err);
    }
};

const broadcastAnnouncement = (message) => {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'announcement', message }));
        }
    });
};
// ฟังก์ชันเพิ่มข้อมูล (สำหรับส่งดอกไม้)
async function addDataToSheet(name, country, flowers) {
    const sheets = await getSheetsClient();
    try {
        const { data } = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: RANKS_RANGE,
        });

        const rows = data.values || [];
        let updated = false;

        for (let i = 0; i < rows.length; i++) {
            if (rows[i][0] === name && rows[i][1] === country) {
                const newCount = (parseInt(rows[i][2]) || 0) + flowers;
                rows[i][2] = newCount;

                await sheets.spreadsheets.values.update({
                    spreadsheetId: SHEET_ID,
                    range: `Sheet1!A${i + 1}:C${i + 1}`,
                    valueInputOption: 'RAW',
                    resource: { values: [[name, country, newCount]] },
                });

                updated = true;
                break;
            }
        }

        if (!updated) {
            await sheets.spreadsheets.values.append({
                spreadsheetId: SHEET_ID,
                range: 'Sheet1!A2',
                valueInputOption: 'RAW',
                resource: { values: [[name, country, flowers]] },
            });
        }

        // เรียกใช้งานฟังก์ชัน Broadcast เพื่อส่งข้อมูล Rank ผ่าน WebSocket
        await broadcastRankUpdates();

    } catch (err) {
        console.error('Error updating Google Sheets:', err);
        throw err;
    }
}


// WebSocket Connection
wss.on('connection', async (ws) => {
    console.log('WebSocket client connected');
    const announcement = await getAnnouncements();
    ws.send(JSON.stringify({ type: 'announcement', message: announcement }));

    const ranks = await getRanks();
    ws.send(JSON.stringify({ type: 'rankUpdate', ranks }));
});

// เริ่มต้นเซิร์ฟเวอร์
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
