const { App } = require('@slack/bolt');
const https = require('https');
const pdf = require('pdf-parse');
const cron = require('node-cron');

// Configuration
const config = {
      managerUserId: process.env.MANAGER_USER_ID,
      hrUserId: process.env.HR_USER_ID,
      roxieUserId: process.env.ROXIE_USER_ID,
      employeeName: process.env.EMPLOYEE_NAME || 'Roxie',
      timesheetChannelId: process.env.TIMESHEET_CHANNEL_ID,
};

const app = new App({
      token: process.env.SLACK_BOT_TOKEN,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      socketMode: true,
      appToken: process.env.SLACK_APP_TOKEN,
});

let timesheetReceivedThisWeek = false;
let lastTimesheetDate = null;

function isFriday() {
      return new Date().getDay() === 5;
}

function resetWeeklyTracker() {
      timesheetReceivedThisWeek = false;
      lastTimesheetDate = null;
      console.log('Weekly timesheet tracker reset');
}

async function downloadFile(url, token) {
      return new Promise((resolve, reject) => {
              const options = { headers: { 'Authorization': `Bearer ${token}` } };
              https.get(url, options, (response) => {
                        const chunks = [];
                        response.on('data', (chunk) => chunks.push(chunk));
                        response.on('end', () => resolve(Buffer.concat(chunks)));
                        response.on('error', reject);
              }).on('error', reject);
      });
}

async function parseTogglPdf(pdfBuffer) {
      const data = await pdf(pdfBuffer);
      const text = data.text;
      const totalHoursMatch = text.match(/TOTAL\s*HOURS[:\s]*(\d{1,3}):(\d{2}):(\d{2})/i);
      if (!totalHoursMatch) throw new Error('Could not find TOTAL HOURS in the PDF');
      const hours = parseInt(totalHoursMatch[1], 10);
      const minutes = parseInt(totalHoursMatch[2], 10);
      const seconds = parseInt(totalHoursMatch[3], 10);
      const dateRangeMatch = text.match(/(\d{2}\/\d{2}\/\d{4})\s*[-]\s*(\d{2}\/\d{2}\/\d{4})/);
      const dateRange = dateRangeMatch ? `${dateRangeMatch[1]} - ${dateRangeMatch[2]}` : 'this week';
      return { hours, minutes, seconds, dateRange };
}

function roundToNearestMinute(hours, minutes, seconds) {
      let totalMinutes = hours * 60 + minutes;
      if (seconds >= 30) totalMinutes += 1;
      return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

function formatTimeMessage(employeeName, roundedTime, dateRange) {
      const { hours, minutes } = roundedTime;
      let timeStr = '';
      if (hours > 0) timeStr += `${hours} hour${hours !== 1 ? 's' : ''}`;
      if (minutes > 0) { if (timeStr) timeStr += ' '; timeStr += `${minutes} minute${minutes !== 1 ? 's' : ''}`; }
      if (!timeStr) timeStr = '0 minutes';
      return `${employeeName}'s time for week of ${dateRange}: *${timeStr}*`;
}

async function sendReminderToRoxie(client) {
      if (!config.roxieUserId) { console.log('No Roxie user ID configured'); return; }
      try {
              await client.chat.postMessage({ channel: config.roxieUserId, text: 'Hi! Friendly reminder: Please send your weekly Toggl timesheet. Thanks!' });
              console.log('Sent reminder to Roxie');
      } catch (error) { console.error('Error sending reminder:', error.message); }
}

app.event('message', async ({ event, client }) => {
      try {
              if (!event.files || event.files.length === 0) return;
              const pdfFile = event.files.find(f => f.mimetype === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
              if (!pdfFile) return;
              const fileName = pdfFile.name.toLowerCase();
              const isTogglExport = fileName.includes('toggl') || fileName.includes('track') || fileName.includes('summary');
              if (!isTogglExport) { console.log(`Ignoring non-Toggl PDF: ${pdfFile.name}`); return; }
              const checkFridayOnly = process.env.FRIDAY_ONLY !== 'false';
              if (checkFridayOnly && !isFriday()) {
                        console.log(`Received Toggl PDF on non-Friday: ${pdfFile.name}`);
                        await client.chat.postMessage({ channel: event.channel, text: 'I received the timesheet, but I only process on Fridays!' });
                        return;
              }
              console.log(`Processing Toggl PDF: ${pdfFile.name}`);
              const pdfBuffer = await downloadFile(pdfFile.url_private, process.env.SLACK_BOT_TOKEN);
              const timeData = await parseTogglPdf(pdfBuffer);
              const roundedTime = roundToNearestMinute(timeData.hours, timeData.minutes, timeData.seconds);
              const hrMessage = formatTimeMessage(config.employeeName, roundedTime, timeData.dateRange);
              await client.chat.postMessage({ channel: config.hrUserId, text: hrMessage });
              console.log(`Sent to HR: ${hrMessage}`);
              timesheetReceivedThisWeek = true;
              lastTimesheetDate = new Date();
              await client.chat.postMessage({ channel: event.channel, text: `I've forwarded ${config.employeeName}'s time to Erickia:\n> ${hrMessage}` });
      } catch (error) {
              console.error('Error processing timesheet:', error);
              if (event.channel) await client.chat.postMessage({ channel: event.channel, text: `Error: ${error.message}` });
      }
});

(async () => {
      await app.start();
      console.log('Timesheet bot is running!');
      console.log(`Manager: ${config.managerUserId}, HR: ${config.hrUserId}, Roxie: ${config.roxieUserId || 'Not set'}`);
      console.log(`Friday-only: ${process.env.FRIDAY_ONLY !== 'false' ? 'ON' : 'OFF'}`);
      cron.schedule('30 17 * * 5', async () => {
              console.log('Friday 5:30 PM check...');
              if (!timesheetReceivedThisWeek) { console.log('No timesheet, sending reminder'); await sendReminderToRoxie(app.client); }
              else console.log('Timesheet received, no reminder needed');
      }, { timezone: 'America/New_York' });
      cron.schedule('0 6 * * 1', () => resetWeeklyTracker(), { timezone: 'America/New_York' });
      console.log('Scheduled: Friday 5:30 PM reminder, Monday 6 AM reset');
})();
