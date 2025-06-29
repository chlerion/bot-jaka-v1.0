// ======================================================================================
// CATATAN PENTING UNTUK MENJALANKAN BOT
// ======================================================================================
// Bot ini paling stabil dijalankan menggunakan Node.js versi 16.
// Jika Anda mengalami galat (error) saat menjalankan, pastikan Anda
// sudah menggunakan NVM (Node Version Manager) untuk beralih ke v16.
//
// 1. Pasang NVM (nvm-windows untuk Windows).
// 2. Buka terminal baru, jalankan: nvm install 16
// 3. Lalu jalankan: nvm use 16
// 4. Setelah itu, jalankan bot secara normal: node bot.js
// ======================================================================================

const fetch = require('node-fetch');
const { FormData, Blob, File } = require('formdata-node');
const { ReadableStream } = require('node:stream/web');

// Mendefinisikan objek global SEBELUM library lain dimuat
global.Headers = fetch.Headers;
global.FormData = FormData;
global.Blob = Blob;
global.File = File;
global.ReadableStream = ReadableStream;

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const { google } = require('googleapis');
const moment = require('moment-timezone');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');

// Mengatur format waktu ke Bahasa Indonesia
moment.locale('id');

// --- Fungsi Helper ---
function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// --- Mengambil Konfigurasi dari file .env ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TARGET_GROUP_NAME = process.env.TARGET_GROUP_NAME;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;

const SHEET_JADWAL = 'Jadwal';
const SHEET_KEUANGAN = 'Keuangan';
const TIMEZONE = 'Asia/Jakarta';

// Validasi konfigurasi
if (!SPREADSHEET_ID || !TARGET_GROUP_NAME || !GEMINI_API_KEY || !GOOGLE_CREDENTIALS_JSON) {
    throw new Error("Error: Variabel environment (SPREADSHEET_ID, TARGET_GROUP_NAME, GEMINI_API_KEY, GOOGLE_CREDENTIALS_JSON) harus di-set.");
}

// --- Inisialisasi Klien & Autentikasi ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

const credentials = JSON.parse(GOOGLE_CREDENTIALS_JSON);
credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');

const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: 'https://www.googleapis.com/auth/spreadsheets',
});
const sheets = google.sheets({ version: 'v4', auth });

// --- Event Listener Utama Bot ---

client.on('qr', qr => {
    console.log('Scan QR Code ini dengan WhatsApp Anda:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Bot WhatsApp JAKA siap digunakan!');
    cron.schedule('0 5 * * *', sendDailyScheduleSummary, { timezone: TIMEZONE });
    cron.schedule('* * * * *', checkAndSendReminders, { timezone: TIMEZONE });
});

client.on('message', async (message) => {
    const mentions = await message.getMentions();
    const botIsMentioned = mentions.some(contact => contact.id._serialized === client.info.me._serialized);

    if (botIsMentioned) {
        const chat = await message.getChat();
        if (chat.isGroup && chat.name === TARGET_GROUP_NAME) {
            const senderName = capitalize((await message.getContact()).pushname);
            const userPrompt = message.body.replace(/@\d+/g, '').trim();
            console.log(`[Mention Diterima] dari ${senderName}: "${userPrompt}"`);
            
            try {
                await processCommandWithAI(userPrompt, message, senderName);
            } catch (error) {
                console.error("Error saat memproses command AI:", error);
                message.reply("Waduh, AI-nya lagi pusing nih, coba lagi nanti ya. 😵");
            }
        }
    }
});

// --- Fungsi Pemrosesan Perintah dengan AI (Gemini) ---

async function processCommandWithAI(prompt, message, senderName) {
    // ** PERBAIKAN: Melatih AI untuk membedakan perintah mencatat dan meminta data **
    const systemPrompt = `Anda adalah AI classifier. Klasifikasikan permintaan pengguna ke dalam format JSON.
Tanggal hari ini: ${moment().tz(TIMEZONE).format('YYYY-MM-DD')}.
Nama pengguna yang mengirim pesan (default person): ${senderName}.

Anda mengenali 6 jenis perintah:
1. 'ADD_JADWAL': Untuk MENAMBAH jadwal baru (contoh kata kerja: "jadwalin", "catat jadwal", "tambahin jadwal"). Ekstrak 'orang', jika tidak disebut, gunakan default person.
2. 'ADD_KEUANGAN': Untuk MENAMBAH keuangan (contoh kata kerja: "catatin uang", "tambah pengeluaran"). Ekstrak 'orang', jika tidak disebut, gunakan default person.
3. 'CEK_JADWAL': Untuk MELIHAT jadwal (contoh kata benda: "jadwal", "agenda"). Ekstrak 'orang'. Jika tidak ada nama spesifik atau disebut kata "kita"/"semua", maka 'orang' adalah 'semua'.
4. 'CEK_SALDO': Untuk mengecek saldo. Ekstrak 'orang' (default: ${senderName}) dan 'jenis_saldo' ('individu' atau 'gabungan').
5. 'LAPORAN_KEUANGAN': Untuk memberikan laporan keuangan (contoh kata benda: "laporan", "catatan keuangan").
6. 'GENERAL_CONVERSATION': Jika permintaan tidak cocok dengan 5 di atas.

Contoh:
- User: "jadwalin bunga meeting jam 2 siang" -> JSON: {"command": "ADD_JADWAL", "payload": {"orang": "Bunga", "waktu": "14:00", "kegiatan": "meeting"}}
- User: "jadwal bunga besok apa aja?" -> JSON: {"command": "CEK_JADWAL", "payload": {"orang": "Bunga", "tanggal": "${moment().tz(TIMEZONE).add(1, 'days').format('YYYY-MM-DD')}"}}
- User: "jadwal kita hari ini" -> JSON: {"command": "CEK_JADWAL", "payload": {"orang": "semua", "tanggal": "${moment().tz(TIMEZONE).format('YYYY-MM-DD')}"}}
- User: "catat pengeluaran bunga 15rb buat ongkir" -> JSON: {"command": "ADD_KEUANGAN", "payload": {"orang": "Bunga", "jenis": "Keluar", "jumlah": 15000, "keterangan": "ongkir"}}
- User: "mana catatan keuangan Bunga" -> JSON: {"command": "LAPORAN_KEUANGAN", "payload": {"jenis_laporan": "semua", "periode": "bulan_ini", "orang": "Bunga"}}
- User: "saldo bunga berapa?" -> JSON: {"command": "CEK_SALDO", "payload": {"orang": "Bunga", "jenis_saldo": "individu"}}
- User: "apa kabar?" -> JSON: {"command": "GENERAL_CONVERSATION", "payload": {"text": "apa kabar?"}}

Jawab HANYA dengan format JSON yang valid. Jangan tambahkan teks lain.`;

    const apiURL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=' + GEMINI_API_KEY;
    
    let response = await fetch(apiURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: systemPrompt + "\nUser: " + prompt }] }] })
    });
    
    let data = await response.json();
    if (!data.candidates || !data.candidates[0].content) {
        console.error("RESPONS GALAT DARI GOOGLE:", JSON.stringify(data, null, 2));
        throw new Error("Invalid response from AI classifier");
    }
    const jsonResponseText = data.candidates[0].content.parts[0].text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(jsonResponseText);

    switch (result.command) {
        case 'ADD_JADWAL': {
            const { waktu, kegiatan } = result.payload;
            const person = capitalize(result.payload.orang || senderName); 
            const tglJadwal = result.payload.tanggal || moment().tz(TIMEZONE).format('YYYY-MM-DD');
            await addSchedule(tglJadwal, waktu, kegiatan, person, message);
            break;
        }
        case 'ADD_KEUANGAN': {
            const { jenis, jumlah, keterangan } = result.payload;
            const person = capitalize(result.payload.orang || senderName);
            const tglTransaksi = result.payload.tanggal || moment().tz(TIMEZONE).format('YYYY-MM-DD');
            await addTransaction(jenis, jumlah, keterangan, person, tglTransaksi, message);
            break;
        }
        case 'CEK_JADWAL': {
            const tglCek = result.payload.tanggal || moment().tz(TIMEZONE).format('YYYY-MM-DD');
            await sendScheduleForDate(tglCek, message, result.payload.orang);
            break;
        }
        case 'CEK_SALDO':
            await checkBalance(result.payload, message, senderName);
            break;
        case 'LAPORAN_KEUANGAN':
            await handleFinancialReport(result.payload, message);
            break;
        case 'GENERAL_CONVERSATION':
            await handleGeneralConversation(result.payload.text, message);
            break;
        default:
            message.reply("Hmm, aku kurang ngerti nih. Bisa coba pake kalimat lain?");
    }
}

// --- Fungsi Spesifik untuk Setiap Perintah ---

async function handleGeneralConversation(text, message) {
    console.log("Menangani percakapan umum:", text);
    const conversationalPrompt = `Anda adalah JAKA, asisten AI yang super santai, gaul, dan kadang suka bercanda di grup chat pasangan. Balas pesan berikut dengan gaya bahasa anak Jaksel, singkat, dan natural. Pesan dari user: "${text}"`;
    
    const apiURL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=' + GEMINI_API_KEY;
    
    const response = await fetch(apiURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: conversationalPrompt }] }] })
    });

    const data = await response.json();
    if (data.candidates && data.candidates[0].content) {
        const replyText = data.candidates[0].content.parts[0].text;
        message.reply(replyText);
    } else {
        message.reply("Hehe, sori, otakku lagi nge-freeze. 😅");
    }
}

async function addSchedule(tanggal, waktu, kegiatan, orang, message) {
    const data = [moment().tz(TIMEZONE).format(), tanggal, waktu, orang, kegiatan, 'TERCATAT'];
    await appendToSheet(SHEET_JADWAL, data);
    const formattedDate = moment(tanggal).format('dddd, DD MMMM YYYY');
    message.reply(`Sip! Jadwal buat *${orang}* untuk *${kegiatan}* jam *${waktu}* di hari *${formattedDate}* udah aku catet ya! ✅`);
}

async function addTransaction(jenis, jumlah, keterangan, orang, tanggal, message) {
    const data = [moment().tz(TIMEZONE).format(), tanggal, jenis, orang, jumlah, keterangan];
    await appendToSheet(SHEET_KEUANGAN, data);
    
    const emoji = jenis === 'Keluar' ? '💸' : '💰';
    const verb = jenis === 'Keluar' ? 'keluar' : 'masuk';
    let replyText = `Oke, beres! Duit *${orang}* ${verb} sebesar *Rp ${jumlah.toLocaleString('id-ID')}* buat *${keterangan}* udah aku catet. ${emoji}`;
    
    if (tanggal !== moment().tz(TIMEZONE).format('YYYY-MM-DD')) {
        replyText += `\n_(Dicatat untuk tanggal ${moment(tanggal).format('DD MMMM')})_`;
    }
    message.reply(replyText);
}

async function checkBalance(payload, message, senderName) {
    const balanceType = payload.jenis_saldo || 'individu';
    const targetPerson = capitalize(payload.orang || senderName);

    const rows = (await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_KEUANGAN}!A:F` })).data.values || [];
    if (!rows || rows.length <= 1) {
        message.reply("Duitnya masih kosong nih, belum ada transaksi sama sekali.");
        return;
    }
    const dataRows = rows.slice(1);
    
    let total = 0;
    let dataToProcess = dataRows;

    if (balanceType === 'individu') {
        dataToProcess = dataRows.filter(row => capitalize(row[3]) === targetPerson);
        if (dataToProcess.length === 0) {
            message.reply(`Belum ada catatan keuangan buat *${targetPerson}* nih.`);
            return;
        }
    }

    dataToProcess.forEach(row => {
        const jenis = row[2];
        const jumlah = parseFloat(row[4]) || 0;
        if (jenis === 'Masuk') total += jumlah;
        if (jenis === 'Keluar') total -= jumlah;
    });

    if (balanceType === 'gabungan') {
        message.reply(`Total saldo gabungan kalian sekarang: *Rp ${total.toLocaleString('id-ID')}*`);
    } else {
        message.reply(`Total saldo buat *${targetPerson}* sekarang: *Rp ${total.toLocaleString('id-ID')}*`);
    }
}


async function sendScheduleForDate(tanggal, message, orang) {
    const targetPerson = orang || 'semua';
    
    const rows = (await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_JADWAL })).data.values || [];
    if (!rows || rows.length <= 1) {
        message.reply(`Nihil, nggak ada jadwal buat tanggal ${moment(tanggal).format('DD MMMM YYYY')}.`);
        return;
    }
    const dataRows = rows.slice(1);
    let filteredSchedules = dataRows.filter(row => row[1] === tanggal);

    if (targetPerson.toLowerCase() !== 'semua') {
        filteredSchedules = filteredSchedules.filter(row => capitalize(row[3]) === capitalize(targetPerson));
    }

    if (filteredSchedules.length === 0) {
        let replyMsg = `Nggak ada jadwal buat tanggal ${moment(tanggal).format('DD MMMM YYYY')}`;
        if (targetPerson.toLowerCase() !== 'semua') {
            replyMsg += ` untuk *${capitalize(targetPerson)}*.`
        }
        message.reply(replyMsg);
        return;
    }
    
    const schedulesByPerson = {};
    filteredSchedules.forEach(row => {
        const person = capitalize(row[3]);
        if (!schedulesByPerson[person]) schedulesByPerson[person] = [];
        schedulesByPerson[person].push(`- Jam *${row[2]}* - ${row[4]}`);
    });

    let title = `🗓️ *Ini jadwal untuk ${moment(tanggal).format('dddd, DD MMMM YYYY')}*`;
    if (targetPerson.toLowerCase() !== 'semua' && Object.keys(schedulesByPerson).length > 0) {
        title = `🗓️ *Ini jadwal untuk ${capitalize(targetPerson)} pada ${moment(tanggal).format('dddd, DD MMMM YYYY')}*`;
    }
    await message.reply(title);
    
    for (const person in schedulesByPerson) {
        let personScheduleText = `*Untuk ${person}:*\n`;
        personScheduleText += schedulesByPerson[person].join('\n');
        await message.reply(personScheduleText);
    }
}

async function handleFinancialReport(payload, message) {
    const jenisLaporan = payload.jenis_laporan || 'semua';
    const periode = payload.periode || 'bulan_ini';
    const orang = payload.orang || 'semua';

    let startDate, endDate, periodText;

    if (periode === 'hari_ini') {
        startDate = moment().tz(TIMEZONE).startOf('day');
        endDate = moment().tz(TIMEZONE).endOf('day');
        periodText = `Hari Ini (${moment().format('dddd, DD MMMM')})`;
    } else if (periode === 'kemarin') {
        startDate = moment().tz(TIMEZONE).subtract(1, 'days').startOf('day');
        endDate = moment().tz(TIMEZONE).subtract(1, 'days').endOf('day');
        periodText = `Kemarin (${startDate.format('dddd, DD MMMM')})`;
    } else if (periode === 'minggu_ini') {
        startDate = moment().tz(TIMEZONE).startOf('week');
        endDate = moment().tz(TIMEZONE).endOf('week');
        periodText = `Minggu Ini (${startDate.format('DD MMM')} - ${endDate.format('DD MMM')})`;
    } else {
        startDate = moment().tz(TIMEZONE).startOf('month');
        endDate = moment().tz(TIMEZONE).endOf('month');
        periodText = `Bulan ${moment().format('MMMM YYYY')}`;
    }

    const rows = (await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_KEUANGAN}!B:F` })).data.values || [];
    if (!rows || rows.length <= 1) {
        message.reply("Belum ada data keuangan buat dibikin laporan.");
        return;
    }
    const dataRows = rows.slice(1);

    const dataInPeriod = dataRows.filter(row => {
        const tgl = moment(row[0], 'YYYY-MM-DD');
        return tgl.isBetween(startDate, endDate, null, '[]');
    }).sort((a, b) => moment(a[0]).diff(moment(b[0]))); 

    if (dataInPeriod.length === 0) {
        message.reply(`Nggak nemu data keuangan di periode ${periodText}.`);
        return;
    }
    
    const uniquePeople = [...new Set(dataInPeriod.map(row => capitalize(row[2])))];
    const peopleToReport = (orang.toLowerCase() === 'semua') ? uniquePeople : [capitalize(orang)];

    let hasDataToSend = false;
    for (const person of peopleToReport) {
        const personData = dataInPeriod.filter(row => capitalize(row[2]) === person);

        if (personData.length > 0) {
            hasDataToSend = true;
            let totalMasuk = 0;
            let totalKeluar = 0;
            let reportDetails = '';

            personData.forEach(row => {
                const tanggal = moment(row[0]).format('DD/MM');
                const jumlah = parseFloat(row[3]) || 0;
                const keterangan = row[4];
                if (row[1] === 'Masuk') {
                    totalMasuk += jumlah;
                } else {
                    totalKeluar += jumlah;
                }
                reportDetails += `\n- _${tanggal}_: [${row[1]}] Rp ${jumlah.toLocaleString('id-ID')} (${keterangan})`;
            });
            
            let titleText = `Laporan Keuangan`;
            if (jenisLaporan !== 'semua') titleText = `Laporan ${jenisLaporan.charAt(0).toUpperCase() + jenisLaporan.slice(1)}`;

            let replyText = `📊 *${titleText} untuk ${person}*\n`;
            replyText += `🗓️ Periode: *${periodText}*\n\n`;

            if (jenisLaporan === 'pemasukan' || jenisLaporan === 'semua') {
                replyText += `✅ *Total Pemasukan:* Rp ${totalMasuk.toLocaleString('id-ID')}\n`;
            }
            if (jenisLaporan === 'pengeluaran' || jenisLaporan === 'semua') {
                replyText += `❌ *Total Pengeluaran:* Rp ${totalKeluar.toLocaleString('id-ID')}\n`;
            }

            replyText += `\n*Rincian:*${reportDetails}`;
            await message.reply(replyText);
        }
    }

    if (!hasDataToSend && orang.toLowerCase() !== 'semua') {
        message.reply(`Nggak nemu data keuangan untuk *${capitalize(orang)}* di periode ${periodText}.`);
    }
}


async function sendDailyScheduleSummary() {
    console.log("Menjalankan tugas harian: Mengirim ringkasan jadwal...");
    const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
    const rows = (await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_JADWAL })).data.values || [];
    if (!rows || rows.length <= 1) return;

    const dataRows = rows.slice(1);
    const todaySchedules = dataRows.filter(row => row[1] === today);
    
    if (todaySchedules.length === 0) {
        console.log("Tidak ada jadwal untuk hari ini.");
        return;
    }
    
    const chats = await client.getChats();
    const targetGroup = chats.find(chat => chat.isGroup && chat.name === TARGET_GROUP_NAME);

    if (targetGroup) {
        const schedulesByPerson = {};
        todaySchedules.forEach(row => {
            const person = capitalize(row[3]);
            if (!schedulesByPerson[person]) {
                schedulesByPerson[person] = [];
            }
            schedulesByPerson[person].push(`- Jam *${row[2]}* - ${row[4]}`);
        });

        for (const person in schedulesByPerson) {
            let summaryText = `*Pagi! ☀️ Ini jadwal buat ${person} hari ini, ${moment(today).format('dddd, DD MMMM YYYY')}*\n`;
            summaryText += schedulesByPerson[person].join('\n');
            await client.sendMessage(targetGroup.id._serialized, summaryText);
        }
        console.log("Ringkasan jadwal harian berhasil dikirim.");
    }
}

async function checkAndSendReminders() {
    console.log(`[${moment().tz(TIMEZONE).format('HH:mm')}] Mengecek pengingat jadwal...`);
    const now = moment().tz(TIMEZONE);
    const todayStr = now.format('YYYY-MM-DD');

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_JADWAL}!A:F`,
        });

        const rows = response.data.values;
        if (!rows || rows.length <= 1) return;

        const chats = await client.getChats();
        const targetGroup = chats.find(chat => chat.isGroup && chat.name === TARGET_GROUP_NAME);
        if (!targetGroup) return;

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const [timestamp, date, time, person, activity, status] = row;
            
            if (date === todayStr && status !== 'SELESAI') {
                const scheduleTime = moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', TIMEZONE);
                const diffMinutes = scheduleTime.diff(now, 'minutes');

                const sendReminder = async (reminderText, newStatus) => {
                    await client.sendMessage(targetGroup.id._serialized, reminderText);
                    await updateScheduleStatus(i + 1, newStatus);
                    console.log(`Mengirim pengingat untuk: ${activity} (${newStatus})`);
                };

                if (diffMinutes > 10 && diffMinutes <= 30 && status === 'TERCATAT') {
                    await sendReminder(`🔔 *Woy, 30 Menit Lagi!* 🔔\n\nJadwal *${activity}* buat *${capitalize(person)}* bentar lagi mulai (jam ${time}).`, 'DIINGATKAN_30');
                } else if (diffMinutes > 5 && diffMinutes <= 10 && (status === 'TERCATAT' || status === 'DIINGATKAN_30')) {
                    await sendReminder(`🔔 *Siap-siap, 10 Menit Lagi!* 🔔\n\nJangan lupa, *${activity}* (jam ${time}) buat *${capitalize(person)}* sebentar lagi!`, 'DIINGATKAN_10');
                } else if (diffMinutes > 0 && diffMinutes <= 5 && (status !== 'DIINGATKAN_5' && status !== 'SELESAI')) {
                     await sendReminder(`🔔 *5 Menit Lagi, Guys!* 🔔\n\nBentar lagi nih! *${activity}* jam ${time} buat *${capitalize(person)}*!`, 'DIINGATKAN_5');
                } else if (diffMinutes <= 0 && diffMinutes > -2 && status !== 'SELESAI') { // Toleransi 2 menit jika cron telat
                     await sendReminder(`✨ *UDAH WAKTUNYA!* ✨\n\nCus, jadwal *${activity}* buat *${capitalize(person)}* dimulai sekarang! Semangat!`, 'SELESAI');
                }
            }
        }
    } catch (error) {
        console.error("Gagal mengecek pengingat:", error);
    }
}

async function updateScheduleStatus(rowIndex, newStatus) {
    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_JADWAL}!F${rowIndex}`,
        valueInputOption: 'RAW',
        resource: {
            values: [[newStatus]],
        },
    });
}

async function appendToSheet(sheetName, data) {
    await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:F`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [data] },
    });
}

// Dummy server untuk Render.com agar tidak timeout
const http = require('http');
const port = process.env.PORT || 3000;

http.createServer((req, res) => {
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong');
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot JAKA is running!');
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`Listening on port ${port}`);
});

// --- Mulai Bot ---
client.initialize().catch(err => console.log("Gagal Initialize:", err));
