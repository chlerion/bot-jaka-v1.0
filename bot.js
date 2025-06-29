// ======================================================================================
// JAKA v2.0 - Platform Multi-Grup
// ======================================================================================
// Bot ini paling stabil dijalankan menggunakan Node.js versi 16.
// Pastikan Anda sudah beralih ke v16 menggunakan NVM sebelum menjalankan.
// Cara menjalankan: node bot.js
// ======================================================================================

const fetch = require('node-fetch');
const { FormData, Blob, File } = require('formdata-node');
const { ReadableStream } = require('node:stream/web');
const http = require('http');

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

// --- Konfigurasi Baru dari file .env ---
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const ADMIN_NUMBER = process.env.ADMIN_NUMBER;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;

const SHEET_JADWAL = 'Jadwal';
const SHEET_KEUANGAN = 'Keuangan';
const MASTER_SHEET_GROUPS = 'Groups';
const TIMEZONE = 'Asia/Jakarta';

// Validasi konfigurasi
if (!MASTER_SHEET_ID || !ADMIN_NUMBER || !GEMINI_API_KEY || !GOOGLE_CREDENTIALS_JSON) {
    throw new Error("Error: Variabel environment (MASTER_SHEET_ID, ADMIN_NUMBER, GEMINI_API_KEY, GOOGLE_CREDENTIALS_JSON) harus di-set.");
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
    console.log('Bot WhatsApp JAKA (Multi-Grup) siap digunakan!');
    cron.schedule('0 5 * * *', () => runCronForAllGroups(sendDailyScheduleSummary), { timezone: TIMEZONE });
    cron.schedule('* * * * *', () => runCronForAllGroups(checkAndSendReminders), { timezone: TIMEZONE });
});

client.on('message', async (message) => {
    const senderNumber = message.from.split('@')[0];
    const chat = await message.getChat();
    const senderName = capitalize((await message.getContact()).pushname);

    if (!chat.isGroup && senderNumber === ADMIN_NUMBER) {
        await handleAdminCommands(message);
        return;
    }

    const isMentioned = message.mentionedIds.includes(client.info.me._serialized);

    if (isMentioned && chat.isGroup) {
        const groupId = chat.id._serialized;
        const groupConfig = await getGroupConfig(groupId);
        const userPrompt = message.body.replace(/@\d+/g, '').trim();

        if (!groupConfig && userPrompt.toLowerCase().startsWith('setup')) {
            await handleSetupCommand(message, chat);
            return;
        }

        if (groupConfig) {
            console.log(`[Mention Diterima] dari ${senderName} di grup ${chat.name}: "${userPrompt}"`);
            try {
                await processCommandWithAI(userPrompt, message, senderName, groupConfig.spreadsheetId);
            } catch (error) {
                console.error("Error saat memproses command AI:", error);
                message.reply("Waduh, AI-nya lagi pusing nih, coba lagi nanti ya. 😵");
            }
        }
    }
});


// --- Fungsi Inti Multi-Grup ---

async function getGroupConfig(groupId) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: `${MASTER_SHEET_GROUPS}!A:E`,
        });
        const rows = response.data.values;
        if (!rows) return null;

        const groupRow = rows.find(row => row[0] === groupId);
        if (groupRow && groupRow[4] && groupRow[4].toLowerCase() === 'aktif') {
            return {
                groupId: groupRow[0],
                groupName: groupRow[1],
                spreadsheetId: groupRow[2],
                adminNotes: groupRow[3],
                status: groupRow[4]
            };
        }
        return null;
    } catch (error) {
        console.error("Gagal mendapatkan konfigurasi grup:", error);
        return null;
    }
}

async function runCronForAllGroups(cronFunction) {
    console.log(`Menjalankan tugas terjadwal: ${cronFunction.name}`);
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: `${MASTER_SHEET_GROUPS}!A:E`,
        });
        const rows = response.data.values;
        if (!rows) return;

        for (const row of rows.slice(1)) {
            const [groupId, groupName, spreadsheetId, adminNotes, status] = row;
            if (status && status.toLowerCase() === 'aktif' && spreadsheetId) {
                await cronFunction(groupId, spreadsheetId);
            }
        }
    } catch (error) {
        console.error("Gagal menjalankan tugas cron untuk semua grup:", error);
    }
}


// --- Fungsi Admin Console ---

async function handleAdminCommands(message) {
    const parts = message.body.trim().split(' ');
    const command = parts[0].toLowerCase();
    console.log(`[Perintah Admin] dari ${message.from}: ${message.body}`);

    switch (command) {
        case '!help':
            await message.reply(
`*ADMIN CONSOLE JAKA*

*Perintah yang tersedia:*
- \`!listgroups\`: Melihat semua grup terdaftar.
- \`!broadcast [pesan]\`: Mengirim pesan ke semua grup aktif.
- \`!addgroup [GroupID] [SpreadsheetID] [Catatan Admin]\`: Mendaftarkan grup baru secara manual.
- \`!removegroup [GroupID]\`: Menonaktifkan grup.

*Setup Grup Baru:*
Untuk mendaftarkan grup baru, undang JAKA ke grup, lalu kirim perintah di dalam grup tersebut:
\`@JAKA setup [ID_SPREADSHEET] [Catatan Admin]\``
            );
            break;

        case '!listgroups': {
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: MASTER_SHEET_ID, range: `${MASTER_SHEET_GROUPS}!A:E`,
            });
            const rows = response.data.values;
            if (!rows || rows.length <= 1) {
                await message.reply("Belum ada grup yang terdaftar.");
                return;
            }
            let reply = '*DAFTAR GRUP TERDAFTAR*\n\n';
            rows.slice(1).forEach(row => {
                reply += `*Nama:* ${row[1]}\n*Notes:* ${row[3]}\n*ID Grup:* \`${row[0]}\`\n*ID Sheet:* \`${row[2]}\`\n*Status:* ${row[4]}\n\n`;
            });
            await message.reply(reply);
            break;
        }

        case '!broadcast': {
            const broadcastMessage = parts.slice(1).join(' ');
            if (!broadcastMessage) {
                await message.reply("Format salah. Gunakan: `!broadcast [pesan]`");
                return;
            }
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: MASTER_SHEET_ID, range: `${MASTER_SHEET_GROUPS}!A:E`,
            });
            const rows = response.data.values;
            if (rows) {
                let count = 0;
                for (const row of rows.slice(1)) {
                    if (row[4] && row[4].toLowerCase() === 'aktif') {
                        try {
                            await client.sendMessage(row[0], `*Pesan dari Admin JAKA:*\n\n${broadcastMessage}`);
                            count++;
                        } catch (err) {
                            console.error(`Gagal mengirim broadcast ke ${row[1]}:`, err);
                        }
                    }
                }
                 await message.reply(`Pesan siaran berhasil dikirim ke ${count} grup aktif.`);
            } else {
                 await message.reply("Tidak ada grup aktif untuk dikirimi pesan.");
            }
            break;
        }

        default:
            await handleGeneralConversation(message.body, message);
            break;
    }
}

// --- Fungsi Setup Grup ---

async function handleSetupCommand(message, chat) {
    const userPrompt = message.body.replace(/@\d+/g, '').trim();
    const parts = userPrompt.split(' '); 

    if (parts.length < 3) {
        message.reply("Format setup salah.\nGunakan: `@JAKA setup [ID_SPREADSHEET] [Catatan Admin]`\n\nContoh:\n`@JAKA setup 1abcde...xyz Grup Keluarga Besar`");
        return;
    }

    const groupId = chat.id._serialized;
    const groupName = chat.name;
    const spreadsheetId = parts[1]; 
    const adminNotes = parts.slice(2).join(' '); 

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: `${MASTER_SHEET_GROUPS}!A:A`,
        });
        const rows = response.data.values || [];
        const groupExists = rows.some(row => row[0] === groupId);

        if (groupExists) {
            message.reply("Grup ini sudah terdaftar sebelumnya.");
            return;
        }

        const newRow = [groupId, groupName, spreadsheetId, adminNotes, 'Aktif'];
        await sheets.spreadsheets.values.append({
            spreadsheetId: MASTER_SHEET_ID,
            range: `${MASTER_SHEET_GROUPS}!A:E`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [newRow] },
        });

        message.reply(`Siap! Grup *${groupName}* berhasil terdaftar. JAKA sekarang aktif di grup ini. ✅`);
    } catch (error) {
        console.error("Gagal melakukan setup:", error);
        message.reply("Gagal mendaftarkan grup. Pastikan ID Master Sheet sudah benar dan saya punya akses Editor.");
    }
}


// --- Fungsi Pemrosesan Perintah AI ---
async function processCommandWithAI(prompt, message, senderName, spreadsheetId) {
    // ** PERBAIKAN: Menambah contoh default untuk laporan dan jadwal **
    const systemPrompt = `Anda adalah AI yang mengubah teks menjadi JSON. Selalu jawab dengan format JSON {"command": "...", "payload": {...}}. Payload harus selalu ada.

Hari ini: ${moment().tz(TIMEZONE).format('YYYY-MM-DD')}.
Pengguna: ${senderName}.

Perintah dan payload yang wajib ada:
1. command: 'ADD_JADWAL', payload: {waktu: string, kegiatan: string, orang: string, tanggal: string}
2. command: 'ADD_KEUANGAN', payload: {jenis: 'Masuk'|'Keluar', jumlah: number, keterangan: string, orang: string, tanggal: string}
3. command: 'CEK_JADWAL', payload: {tanggal: string, orang: string}
4. command: 'LAPORAN_KEUANGAN', payload: {periode: 'hari_ini'|'kemarin'|'minggu_ini'|'bulan_ini', orang: string, jenis_laporan: 'pemasukan'|'pengeluaran'|'semua'}
5. command: 'CEK_SALDO', payload: {jenis_saldo: 'individu'|'gabungan', orang: string}
6. command: 'GENERAL_CONVERSATION', payload: {text: string}

Contoh:
- User: "jadwalin aku meeting jam 8" -> {"command": "ADD_JADWAL", "payload": {"waktu": "08:00", "kegiatan": "meeting", "orang": "${senderName}", "tanggal": "${moment().tz(TIMEZONE).format('YYYY-MM-DD')}"}}
- User: "lihat jadwal Bunga besok" -> {"command": "CEK_JADWAL", "payload": {"tanggal": "${moment().tz(TIMEZONE).add(1, 'days').format('YYYY-MM-DD')}", "orang": "Bunga"}}
- User: "jadwal" -> {"command": "CEK_JADWAL", "payload": {"tanggal": "${moment().tz(TIMEZONE).format('YYYY-MM-DD')}", "orang": "semua"}}
- User: "keluar 20rb buat jajan kemarin" -> {"command": "ADD_KEUANGAN", "payload": {"jenis": "Keluar", "jumlah": 20000, "keterangan": "jajan", "tanggal": "${moment().tz(TIMEZONE).subtract(1, 'days').format('YYYY-MM-DD')}", "orang": "${senderName}"}}
- User: "laporan" -> {"command": "LAPORAN_KEUANGAN", "payload": {"periode": "bulan_ini", "orang": "semua", "jenis_laporan": "semua"}}
- User: "hi" -> {"command": "GENERAL_CONVERSATION", "payload": {"text": "hi"}}

Ubah teks berikut ke JSON. JANGAN BERI PENJELASAN, HANYA JSON.`;
    
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

    if (!result.payload) {
        message.reply("Maaf, aku agak bingung sama permintaannya. Bisa coba dengan kalimat yang lebih jelas?");
        return;
    }
    
    switch (result.command) {
        case 'ADD_JADWAL': {
            const payload = result.payload;
            if (!payload.waktu || !payload.kegiatan) {
                message.reply("Untuk nambahin jadwal, aku butuh info waktu dan kegiatannya apa, ya.");
                return;
            }
            const person = capitalize(payload.orang || senderName); 
            const tglJadwal = payload.tanggal || moment().tz(TIMEZONE).format('YYYY-MM-DD');
            await addSchedule(tglJadwal, payload.waktu, payload.kegiatan, person, message, spreadsheetId);
            break;
        }
        case 'ADD_KEUANGAN': {
            const payload = result.payload;
            if (!payload.jenis || !payload.jumlah || !payload.keterangan) {
                message.reply("Untuk nyatet keuangan, aku butuh info jenis (masuk/keluar), jumlah, sama keterangannya.");
                return;
            }
            const person = capitalize(payload.orang || senderName);
            const tglTransaksi = payload.tanggal || moment().tz(TIMEZONE).format('YYYY-MM-DD');
            await addTransaction(payload.jenis, payload.jumlah, payload.keterangan, person, tglTransaksi, message, spreadsheetId);
            break;
        }
        case 'CEK_JADWAL': {
            const payload = result.payload;
            const tglCek = payload.tanggal || moment().tz(TIMEZONE).format('YYYY-MM-DD');
            await sendScheduleForDate(tglCek, message, payload.orang, spreadsheetId);
            break;
        }
        case 'CEK_SALDO':
            await checkBalance(result.payload, message, senderName, spreadsheetId);
            break;
        case 'LAPORAN_KEUANGAN':
            await handleFinancialReport(result.payload, message, spreadsheetId);
            break;
        case 'GENERAL_CONVERSATION':
            await handleGeneralConversation(result.payload.text, message);
            break;
        default:
            message.reply("Hmm, aku kurang ngerti nih. Bisa coba pake kalimat lain?");
    }
}

// --- Fungsi Fungsional (sekarang menerima spreadsheetId) ---
async function handleGeneralConversation(text, message) {
    const conversationalPrompt = `Anda adalah JAKA, asisten AI yang super santai, gaul, dan kadang suka bercanda. Balas pesan berikut dengan gaya bahasa anak Jaksel, singkat, dan natural. Pesan dari user: "${text}"`;
    const apiURL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=' + GEMINI_API_KEY;
    const response = await fetch(apiURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: conversationalPrompt }] }] })
    });
    const data = await response.json();
    if (data.candidates && data.candidates[0].content) {
        message.reply(data.candidates[0].content.parts[0].text);
    } else {
        message.reply("Hehe, sori, otakku lagi nge-freeze. 😅");
    }
}

async function addSchedule(tanggal, waktu, kegiatan, orang, message, spreadsheetId) {
    const data = [moment().tz(TIMEZONE).format(), tanggal, waktu, orang, kegiatan, 'TERCATAT'];
    await appendToSheet(spreadsheetId, SHEET_JADWAL, data);
    const formattedDate = moment(tanggal).format('dddd, DD MMMM YYYY');
    message.reply(`Sip! Jadwal buat *${orang}* untuk *${kegiatan}* jam *${waktu}* di hari *${formattedDate}* udah aku catet ya! ✅`);
}

async function addTransaction(jenis, jumlah, keterangan, orang, tanggal, message, spreadsheetId) {
    const data = [moment().tz(TIMEZONE).format(), tanggal, jenis, orang, jumlah, keterangan];
    await appendToSheet(spreadsheetId, SHEET_KEUANGAN, data);
    const emoji = jenis === 'Keluar' ? '💸' : '💰';
    const verb = jenis === 'Keluar' ? 'keluar' : 'masuk';
    let replyText = `Oke, beres! Duit *${orang}* ${verb} sebesar *Rp ${jumlah.toLocaleString('id-ID')}* buat *${keterangan}* udah aku catet. ${emoji}`;
    if (tanggal !== moment().tz(TIMEZONE).format('YYYY-MM-DD')) {
        replyText += `\n_(Dicatat untuk tanggal ${moment(tanggal).format('DD MMMM')})_`;
    }
    message.reply(replyText);
}

async function checkBalance(payload, message, senderName, spreadsheetId) {
    const balanceType = payload.jenis_saldo || 'individu';
    const targetPerson = capitalize(payload.orang || senderName);
    const rows = (await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_KEUANGAN}!A:F` })).data.values || [];
    if (!rows || rows.length <= 1) { message.reply("Belum ada transaksi di grup ini."); return; }
    const dataRows = rows.slice(1);
    let total = 0;
    let dataToProcess = dataRows;
    if (balanceType === 'individu') {
        dataToProcess = dataRows.filter(row => capitalize(row[3]) === targetPerson);
        if (dataToProcess.length === 0) { message.reply(`Belum ada catatan keuangan buat *${targetPerson}* nih.`); return; }
    }
    dataToProcess.forEach(row => {
        const jenis = row[2];
        const jumlah = parseFloat(row[4]) || 0;
        if (jenis === 'Masuk') total += jumlah;
        if (jenis === 'Keluar') total -= jumlah;
    });
    if (balanceType === 'gabungan') {
        message.reply(`Total saldo gabungan di grup ini sekarang: *Rp ${total.toLocaleString('id-ID')}*`);
    } else {
        message.reply(`Total saldo buat *${targetPerson}* sekarang: *Rp ${total.toLocaleString('id-ID')}*`);
    }
}

async function sendScheduleForDate(tanggal, message, orang, spreadsheetId) {
    const targetPerson = orang || 'semua';
    const rows = (await sheets.spreadsheets.values.get({ spreadsheetId, range: SHEET_JADWAL })).data.values || [];
    if (!rows || rows.length <= 1) { message.reply(`Nihil, nggak ada jadwal buat tanggal ${moment(tanggal).format('DD MMMM YYYY')}.`); return; }
    const dataRows = rows.slice(1);
    let filteredSchedules = dataRows.filter(row => row[1] === tanggal);
    if (targetPerson.toLowerCase() !== 'semua') {
        filteredSchedules = filteredSchedules.filter(row => capitalize(row[3]) === capitalize(targetPerson));
    }
    if (filteredSchedules.length === 0) {
        let replyMsg = `Nggak ada jadwal buat tanggal ${moment(tanggal).format('DD MMMM YYYY')}`;
        if (targetPerson.toLowerCase() !== 'semua') { replyMsg += ` untuk *${capitalize(targetPerson)}*.` }
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
        let personScheduleText = `*Untuk ${person}:*\n` + schedulesByPerson[person].join('\n');
        await message.reply(personScheduleText);
    }
}

async function handleFinancialReport(payload, message, spreadsheetId) {
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
    const rows = (await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_KEUANGAN}!B:F` })).data.values || [];
    if (!rows || rows.length <= 1) { message.reply("Belum ada data keuangan buat dibikin laporan."); return; }
    const dataRows = rows.slice(1);
    const dataInPeriod = dataRows.filter(row => moment(row[0], 'YYYY-MM-DD').isBetween(startDate, endDate, null, '[]')).sort((a, b) => moment(a[0]).diff(moment(b[0])));
    if (dataInPeriod.length === 0) { message.reply(`Nggak nemu data keuangan di periode ${periodText}.`); return; }
    const uniquePeople = [...new Set(dataInPeriod.map(row => capitalize(row[2])))];
    const peopleToReport = (orang.toLowerCase() === 'semua') ? uniquePeople : [capitalize(orang)];
    let hasDataToSend = false;
    for (const person of peopleToReport) {
        const personData = dataInPeriod.filter(row => capitalize(row[2]) === person);
        if (personData.length > 0) {
            hasDataToSend = true;
            let totalMasuk = 0, totalKeluar = 0, reportDetails = '';
            personData.forEach(row => {
                const [tanggal, jenis, , jumlah, keterangan] = row;
                const nominal = parseFloat(jumlah) || 0;
                if (jenis === 'Masuk') totalMasuk += nominal;
                else totalKeluar += nominal;
                reportDetails += `\n- _${moment(tanggal).format('DD/MM')}_: [${jenis}] Rp ${nominal.toLocaleString('id-ID')} (${keterangan})`;
            });
            let titleText = `Laporan Keuangan`;
            if (jenisLaporan !== 'semua') titleText = `Laporan ${jenisLaporan.charAt(0).toUpperCase() + jenisLaporan.slice(1)}`;
            let replyText = `📊 *${titleText} untuk ${person}*\n🗓️ Periode: *${periodText}*\n\n`;
            if (jenisLaporan === 'pemasukan' || jenisLaporan === 'semua') replyText += `✅ *Total Pemasukan:* Rp ${totalMasuk.toLocaleString('id-ID')}\n`;
            if (jenisLaporan === 'pengeluaran' || jenisLaporan === 'semua') replyText += `❌ *Total Pengeluaran:* Rp ${totalKeluar.toLocaleString('id-ID')}\n`;
            replyText += `\n*Rincian:*${reportDetails}`;
            await message.reply(replyText);
        }
    }
    if (!hasDataToSend && orang.toLowerCase() !== 'semua') { message.reply(`Nggak nemu data keuangan untuk *${capitalize(orang)}* di periode ${periodText}.`); }
}

// --- Fungsi Cron & Helper ---
async function sendDailyScheduleSummary(groupId, spreadsheetId) {
    const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
    const rows = (await sheets.spreadsheets.values.get({ spreadsheetId, range: SHEET_JADWAL })).data.values || [];
    if (!rows || rows.length <= 1) return;
    const dataRows = rows.slice(1);
    const todaySchedules = dataRows.filter(row => row[1] === today);
    if (todaySchedules.length === 0) { console.log(`Tidak ada jadwal untuk hari ini di grup ${groupId}`); return; }
    const schedulesByPerson = {};
    todaySchedules.forEach(row => {
        const person = capitalize(row[3]);
        if (!schedulesByPerson[person]) schedulesByPerson[person] = [];
        schedulesByPerson[person].push(`- Jam *${row[2]}* - ${row[4]}`);
    });
    for (const person in schedulesByPerson) {
        let summaryText = `*Pagi! ☀️ Ini jadwal buat ${person} hari ini, ${moment(today).format('dddd, DD MMMM YYYY')}*\n` + schedulesByPerson[person].join('\n');
        await client.sendMessage(groupId, summaryText);
    }
    console.log("Ringkasan jadwal harian berhasil dikirim ke grup " + groupId);
}

async function checkAndSendReminders(groupId, spreadsheetId) {
    const now = moment().tz(TIMEZONE);
    const todayStr = now.format('YYYY-MM-DD');
    try {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_JADWAL}!A:F` });
        const rows = response.data.values;
        if (!rows || rows.length <= 1) return;
        for (let i = 1; i < rows.length; i++) {
            const [timestamp, date, time, person, activity, status] = rows[i];
            if (date === todayStr && status !== 'SELESAI') {
                const scheduleTime = moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', TIMEZONE);
                const diffMinutes = scheduleTime.diff(now, 'minutes');
                const sendReminder = async (reminderText, newStatus) => {
                    await client.sendMessage(groupId, reminderText);
                    await updateScheduleStatus(spreadsheetId, i + 1, newStatus);
                    console.log(`Mengirim pengingat untuk: ${activity} (${newStatus}) di grup ${groupId}`);
                };
                if (diffMinutes > 10 && diffMinutes <= 30 && status === 'TERCATAT') await sendReminder(`🔔 *Woy, 30 Menit Lagi!* 🔔\n\nJadwal *${activity}* buat *${capitalize(person)}* bentar lagi mulai (jam ${time}).`, 'DIINGATKAN_30');
                else if (diffMinutes > 5 && diffMinutes <= 10 && (status === 'TERCATAT' || status === 'DIINGATKAN_30')) await sendReminder(`🔔 *Siap-siap, 10 Menit Lagi!* 🔔\n\nJangan lupa, *${activity}* (jam ${time}) buat *${capitalize(person)}* sebentar lagi!`, 'DIINGATKAN_10');
                else if (diffMinutes > 0 && diffMinutes <= 5 && (status !== 'DIINGATKAN_5' && status !== 'SELESAI')) await sendReminder(`� *5 Menit Lagi, Guys!* 🔔\n\nBentar lagi nih! *${activity}* jam ${time} buat *${capitalize(person)}*!`, 'DIINGATKAN_5');
                else if (diffMinutes <= 0 && diffMinutes > -2 && status !== 'SELESAI') await sendReminder(`✨ *UDAH WAKTUNYA!* ✨\n\nCus, jadwal *${activity}* buat *${capitalize(person)}* dimulai sekarang! Semangat!`, 'SELESAI');
            }
        }
    } catch (error) { console.error("Gagal mengecek pengingat:", error); }
}

async function updateScheduleStatus(spreadsheetId, rowIndex, newStatus) {
    await sheets.spreadsheets.values.update({
        spreadsheetId, range: `${SHEET_JADWAL}!F${rowIndex}`, valueInputOption: 'RAW', resource: { values: [[newStatus]] },
    });
}

async function appendToSheet(spreadsheetId, sheetName, data) {
    await sheets.spreadsheets.values.append({
        spreadsheetId, range: `${sheetName}!A:F`, valueInputOption: 'USER_ENTERED', resource: { values: [data] },
    });
}

// --- Mulai Bot ---
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  if (req.url === '/ping') {
    res.end('pong'); // UptimeRobot expects 200 OK and any body
  } else {
    res.end('Bot JAKA Multi-Group is running!');
  }
}).listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log(`Listening on port ${process.env.PORT || 3000}`);
});

client.initialize().catch(err => console.log("Gagal Initialize:", err));
